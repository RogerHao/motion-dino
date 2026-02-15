"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";

export type PoseGesture = "IDLE" | "JUMP" | "DUCK";
export type PoseTrackingStatus = "idle" | "loading" | "calibrating" | "tracking" | "no-person" | "error";
export type TrackingTier = 1 | 2 | 3;

interface UsePoseGestureOptions {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
}

interface UsePoseGestureState {
  gesture: PoseGesture;
  status: PoseTrackingStatus;
  calibrationProgress: number;
  errorMessage: string | null;
  trackingTier: TrackingTier;
}

const MODEL_ASSET_PATH =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_BASE_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";

const DETECTION_INTERVAL_MS = 34;
const BASELINE_SMOOTHING = 0.85;
const JUMP_THRESHOLD = 0.10;
const QUICK_JUMP_THRESHOLD = 0.065;
const QUICK_JUMP_VELOCITY = 0.010;
const DUCK_THRESHOLD = 0.09;
const CALIBRATION_FRAMES = 15;
const DEBOUNCE_MS = 90;
const MIN_VISIBILITY = 0.18;
const MAX_MISSING_FRAMES = 20;
const RECALIBRATION_DRIFT_THRESHOLD = 0.35;
const RECALIBRATION_FRAMES = 10;
const IDLE_ACCELERATION_FRAMES = 60;
const IDLE_SMOOTHING = 0.75;

const INITIAL_STATE: UsePoseGestureState = {
  gesture: "IDLE",
  status: "idle",
  calibrationProgress: 0,
  errorMessage: null,
  trackingTier: 1,
};

interface GestureRuntime {
  baseline: number | null;
  calibrationBuffer: number[];
  stableGesture: PoseGesture;
  pendingGesture: PoseGesture | null;
  pendingSince: number;
  missingFrames: number;
  lastDetectAt: number;
  lastSignal: number | null;
  driftFrames: number;
  idleFrames: number;
  recalibrating: boolean;
  trackingTier: TrackingTier;
}

const createRuntime = (): GestureRuntime => ({
  baseline: null,
  calibrationBuffer: [],
  stableGesture: "IDLE",
  pendingGesture: null,
  pendingSince: 0,
  missingFrames: 0,
  lastDetectAt: 0,
  lastSignal: null,
  driftFrames: 0,
  idleFrames: 0,
  recalibrating: false,
  trackingTier: 1,
});

interface TierResult {
  tier: TrackingTier;
  signal: number;
  thresholdMultiplier: number;
}

function computeTierSignal(landmarks: NormalizedLandmark[]): TierResult | null {
  const nose = landmarks[0];
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];

  const headCandidates = [nose, leftEar, rightEar].filter(
    (point) => point && point.visibility >= MIN_VISIBILITY,
  );
  const hasShoulder =
    leftShoulder &&
    rightShoulder &&
    leftShoulder.visibility >= MIN_VISIBILITY &&
    rightShoulder.visibility >= MIN_VISIBILITY;

  const shoulderMidY = hasShoulder ? (leftShoulder.y + rightShoulder.y) / 2 : 0;
  const shoulderSpan = hasShoulder
    ? Math.max(0.09, Math.abs(rightShoulder.x - leftShoulder.x))
    : 0;

  // Tier 1: Full — both shoulders + head
  if (hasShoulder && headCandidates.length > 0) {
    const headY =
      headCandidates.reduce((sum, point) => sum + point.y, 0) / headCandidates.length;
    const upperBodySignal = (headY * 0.52 + shoulderMidY * 0.48) / shoulderSpan;
    return { tier: 1, signal: upperBodySignal, thresholdMultiplier: 1.0 };
  }

  // Tier 2: Head-only — >=2 head landmarks, no shoulders
  if (headCandidates.length >= 2) {
    const headY =
      headCandidates.reduce((sum, point) => sum + point.y, 0) / headCandidates.length;
    const headXs = headCandidates.map((p) => p.x);
    const headSpan = Math.max(0.06, Math.max(...headXs) - Math.min(...headXs));
    const headSignal = headY / headSpan;
    return { tier: 2, signal: headSignal, thresholdMultiplier: 1.2 };
  }

  // Tier 3: Shoulder-only — both shoulders, no head
  if (hasShoulder) {
    const shoulderSignal = shoulderMidY / shoulderSpan;
    return { tier: 3, signal: shoulderSignal, thresholdMultiplier: 0.85 };
  }

  return null;
}

function estimateGesture(landmarks: NormalizedLandmark[], runtime: GestureRuntime, now: number): PoseGesture {
  const tierResult = computeTierSignal(landmarks);

  if (!tierResult) {
    runtime.missingFrames += 1;
    runtime.lastSignal = null;
    return "IDLE";
  }

  runtime.missingFrames = 0;
  runtime.trackingTier = tierResult.tier;
  const { signal, thresholdMultiplier } = tierResult;

  const riseVelocity =
    runtime.lastSignal === null ? 0 : runtime.lastSignal - signal;
  runtime.lastSignal = signal;

  // Calibration phase (initial or recalibration)
  if (runtime.baseline === null || runtime.recalibrating) {
    runtime.calibrationBuffer.push(signal);
    const needed = runtime.recalibrating ? RECALIBRATION_FRAMES : CALIBRATION_FRAMES;
    if (runtime.calibrationBuffer.length >= needed) {
      const sum = runtime.calibrationBuffer.reduce((acc, value) => acc + value, 0);
      runtime.baseline = sum / runtime.calibrationBuffer.length;
      runtime.calibrationBuffer = [];
      runtime.recalibrating = false;
      runtime.driftFrames = 0;
      runtime.idleFrames = 0;
    }
    return "IDLE";
  }

  // Baseline adaptation
  if (runtime.stableGesture === "IDLE") {
    runtime.idleFrames += 1;
    const smoothing =
      runtime.idleFrames > IDLE_ACCELERATION_FRAMES ? IDLE_SMOOTHING : BASELINE_SMOOTHING;
    runtime.baseline =
      runtime.baseline * smoothing + signal * (1 - smoothing);
  } else {
    runtime.idleFrames = 0;
  }

  // Auto-recalibration: detect drift while IDLE
  const drift = Math.abs(signal - runtime.baseline);
  if (runtime.stableGesture === "IDLE" && drift > RECALIBRATION_DRIFT_THRESHOLD) {
    runtime.driftFrames += 1;
    if (runtime.driftFrames >= CALIBRATION_FRAMES) {
      runtime.recalibrating = true;
      runtime.calibrationBuffer = [signal];
      runtime.driftFrames = 0;
      return "IDLE";
    }
  } else {
    runtime.driftFrames = 0;
  }

  const jumpThreshold = JUMP_THRESHOLD * thresholdMultiplier;
  const quickJumpThreshold = QUICK_JUMP_THRESHOLD * thresholdMultiplier;
  const quickJumpVelocity = QUICK_JUMP_VELOCITY * thresholdMultiplier;
  const duckThreshold = DUCK_THRESHOLD * thresholdMultiplier;

  const jumpDelta = runtime.baseline - signal;
  const duckDelta = signal - runtime.baseline;

  let candidate: PoseGesture = "IDLE";
  if (
    jumpDelta > jumpThreshold ||
    (jumpDelta > quickJumpThreshold && riseVelocity > quickJumpVelocity)
  ) {
    candidate = "JUMP";
  } else if (duckDelta > duckThreshold) {
    candidate = "DUCK";
  }

  if (candidate === runtime.stableGesture) {
    runtime.pendingGesture = null;
    return runtime.stableGesture;
  }

  if (runtime.pendingGesture !== candidate) {
    runtime.pendingGesture = candidate;
    runtime.pendingSince = now;
    return runtime.stableGesture;
  }

  if (now - runtime.pendingSince >= DEBOUNCE_MS) {
    runtime.stableGesture = candidate;
    runtime.pendingGesture = null;
  }

  return runtime.stableGesture;
}

export function usePoseGesture({ enabled, videoRef }: UsePoseGestureOptions): UsePoseGestureState {
  const [state, setState] = useState<UsePoseGestureState>(INITIAL_STATE);
  const stateRef = useRef<UsePoseGestureState>(INITIAL_STATE);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const initPromiseRef = useRef<Promise<PoseLandmarker> | null>(null);
  const rafRef = useRef<number | null>(null);
  const runtimeRef = useRef<GestureRuntime>(createRuntime());

  const publish = (partial: Partial<UsePoseGestureState>) => {
    const current = stateRef.current;
    const next: UsePoseGestureState = {
      gesture: partial.gesture ?? current.gesture,
      status: partial.status ?? current.status,
      calibrationProgress: partial.calibrationProgress ?? current.calibrationProgress,
      errorMessage: partial.errorMessage ?? current.errorMessage,
      trackingTier: partial.trackingTier ?? current.trackingTier,
    };
    if (
      next.gesture === current.gesture &&
      next.status === current.status &&
      next.calibrationProgress === current.calibrationProgress &&
      next.errorMessage === current.errorMessage &&
      next.trackingTier === current.trackingTier
    ) {
      return;
    }
    stateRef.current = next;
    setState(next);
  };

  const ensureLandmarker = async (): Promise<PoseLandmarker> => {
    if (landmarkerRef.current) {
      return landmarkerRef.current;
    }
    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    initPromiseRef.current = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE_PATH);
      const landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_ASSET_PATH,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      landmarkerRef.current = landmarker;
      return landmarker;
    })();

    try {
      return await initPromiseRef.current;
    } finally {
      initPromiseRef.current = null;
    }
  };

  useEffect(() => {
    if (!enabled) {
      runtimeRef.current = createRuntime();
      publish(INITIAL_STATE);
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let stopped = false;
    runtimeRef.current = createRuntime();
    publish({
      status: "loading",
      gesture: "IDLE",
      calibrationProgress: 0,
      errorMessage: null,
      trackingTier: 1,
    });

    const loop = async () => {
      try {
        const video = videoRef.current;
        if (stopped || !video) {
          return;
        }

        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          rafRef.current = window.requestAnimationFrame(() => {
            void loop();
          });
          return;
        }

        const now = performance.now();
        const runtime = runtimeRef.current;
        if (now - runtime.lastDetectAt < DETECTION_INTERVAL_MS) {
          rafRef.current = window.requestAnimationFrame(() => {
            void loop();
          });
          return;
        }
        runtime.lastDetectAt = now;

        const landmarker = await ensureLandmarker();
        if (stopped) {
          return;
        }

        const result = landmarker.detectForVideo(video, now);
        const landmarks = result.landmarks[0];

        if (!landmarks || landmarks.length < 13) {
          runtime.missingFrames += 1;
          if (runtime.missingFrames > MAX_MISSING_FRAMES) {
            publish({
              status: "no-person",
              gesture: "IDLE",
              calibrationProgress: runtime.baseline ? 1 : runtime.calibrationBuffer.length / CALIBRATION_FRAMES,
              errorMessage: null,
              trackingTier: runtime.trackingTier,
            });
          }
          rafRef.current = window.requestAnimationFrame(() => {
            void loop();
          });
          return;
        }

        const gesture = estimateGesture(landmarks, runtime, now);
        if (runtime.missingFrames > MAX_MISSING_FRAMES) {
          publish({
            status: "no-person",
            gesture: "IDLE",
            calibrationProgress: runtime.baseline ? 1 : runtime.calibrationBuffer.length / CALIBRATION_FRAMES,
            errorMessage: null,
            trackingTier: runtime.trackingTier,
          });
          rafRef.current = window.requestAnimationFrame(() => {
            void loop();
          });
          return;
        }
        const calibrated = runtime.baseline !== null && !runtime.recalibrating;
        const calFrames = runtime.recalibrating ? RECALIBRATION_FRAMES : CALIBRATION_FRAMES;
        publish({
          status: calibrated ? "tracking" : "calibrating",
          gesture,
          calibrationProgress: calibrated ? 1 : runtime.calibrationBuffer.length / calFrames,
          errorMessage: null,
          trackingTier: runtime.trackingTier,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "姿态识别初始化失败";
        publish({
          status: "error",
          gesture: "IDLE",
          errorMessage: message,
          calibrationProgress: 0,
          trackingTier: 1,
        });
      }

      if (!stopped) {
        rafRef.current = window.requestAnimationFrame(() => {
          void loop();
        });
      }
    };

    rafRef.current = window.requestAnimationFrame(() => {
      void loop();
    });

    return () => {
      stopped = true;
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, videoRef]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
        landmarkerRef.current = null;
      }
    };
  }, []);

  return state;
}

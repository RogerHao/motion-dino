"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { PoseGesture, PoseTrackingStatus } from "@/hooks/usePoseGesture";
import { SkeletonCanvas } from "./SkeletonCanvas";
import { CHALLENGES, checkPoseMatch } from "@/lib/poseMatchGame";
import type { PoseChallenge } from "@/lib/poseMatchGame";
import {
  createConfettiBurst,
  createConfettiRain,
  updateConfetti,
  drawConfetti,
} from "@/lib/confetti";
import type { ConfettiParticle } from "@/lib/confetti";

type WelcomePhase = "detect" | "calibrate" | "ready";

interface PoseState {
  gesture: PoseGesture;
  status: PoseTrackingStatus;
  calibrationProgress: number;
  landmarksRef: RefObject<NormalizedLandmark[] | null>;
}

interface WelcomeSceneProps {
  pose: PoseState;
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraState: string;
  onComplete: () => void;
  onSkip: () => void;
}

export function WelcomeScene({ pose, videoRef, cameraState, onComplete, onSkip }: WelcomeSceneProps) {
  const [phase, setPhase] = useState<WelcomePhase>("detect");
  const [bodyDetected, setBodyDetected] = useState(false);
  const [skeletonOpacity, setSkeletonOpacity] = useState(0);
  const [challengeIdx, setChallengeIdx] = useState(0);
  const [feedbackText, setFeedbackText] = useState<string | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);

  const holdStartRef = useRef<number | null>(null);
  const challengeStartRef = useRef<number>(0);
  const phaseTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const advancingRef = useRef(false);

  // Confetti state
  const confettiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const confettiRef = useRef<ConfettiParticle[]>([]);
  const confettiRafRef = useRef<number | null>(null);

  // Confetti render loop
  useEffect(() => {
    const loop = () => {
      const canvas = confettiCanvasRef.current;
      if (canvas) {
        const parent = canvas.parentElement;
        if (parent) {
          if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
            canvas.width = parent.clientWidth;
            canvas.height = parent.clientHeight;
          }
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          confettiRef.current = updateConfetti(confettiRef.current, 1 / 60);
          drawConfetti(ctx, confettiRef.current);
        }
      }
      confettiRafRef.current = requestAnimationFrame(loop);
    };
    confettiRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (confettiRafRef.current) cancelAnimationFrame(confettiRafRef.current);
    };
  }, []);

  const triggerBurst = useCallback(() => {
    const canvas = confettiCanvasRef.current;
    const cx = canvas ? canvas.width / 2 : 400;
    const cy = canvas ? canvas.height / 2 : 300;
    confettiRef.current = [...confettiRef.current, ...createConfettiBurst(cx, cy, 35)];
  }, []);

  const triggerRain = useCallback(() => {
    const canvas = confettiCanvasRef.current;
    const w = canvas ? canvas.width : 800;
    confettiRef.current = [...confettiRef.current, ...createConfettiRain(w, 60)];
  }, []);

  // --- Phase 1: Detect ---
  useEffect(() => {
    if (phase !== "detect") return;

    const hasBody = pose.status === "calibrating" || pose.status === "tracking";
    if (hasBody && !bodyDetected) {
      setBodyDetected(true);
      // Fade in skeleton over 500ms
      let start: number | null = null;
      const fadeIn = (ts: number) => {
        if (!start) start = ts;
        const progress = Math.min(1, (ts - start) / 500);
        setSkeletonOpacity(progress);
        if (progress < 1) requestAnimationFrame(fadeIn);
      };
      requestAnimationFrame(fadeIn);

      // Auto-advance after 2s of stable detection
      phaseTimerRef.current = window.setTimeout(() => {
        setPhase("calibrate");
        challengeStartRef.current = performance.now();
      }, 2000);
    }

    if (!hasBody && bodyDetected) {
      setBodyDetected(false);
      setSkeletonOpacity(0);
      if (phaseTimerRef.current) {
        clearTimeout(phaseTimerRef.current);
        phaseTimerRef.current = null;
      }
    }

    return () => {
      if (phaseTimerRef.current) {
        clearTimeout(phaseTimerRef.current);
        phaseTimerRef.current = null;
      }
    };
  }, [phase, pose.status, bodyDetected]);

  // --- Phase 2: Calibrate (pose challenges) ---
  const currentChallenge: PoseChallenge | undefined = CHALLENGES[challengeIdx];

  const advanceChallenge = useCallback(
    (isTimeout: boolean) => {
      if (advancingRef.current) return;
      advancingRef.current = true;

      const challenge = CHALLENGES[challengeIdx];
      const text = isTimeout ? challenge.timeoutText : challenge.successText;
      setFeedbackText(text);
      triggerBurst();

      feedbackTimerRef.current = window.setTimeout(() => {
        setFeedbackText(null);
        advancingRef.current = false;

        const nextIdx = challengeIdx + 1;
        if (nextIdx >= CHALLENGES.length) {
          setPhase("ready");
        } else {
          setChallengeIdx(nextIdx);
          holdStartRef.current = null;
          setHoldProgress(0);
          challengeStartRef.current = performance.now();
        }
      }, 1200);
    },
    [challengeIdx, triggerBurst],
  );

  // Check pose matching during calibrate phase
  useEffect(() => {
    if (phase !== "calibrate" || !currentChallenge || advancingRef.current) return;

    const now = performance.now();

    // Timeout check
    if (now - challengeStartRef.current > currentChallenge.timeoutMs) {
      advanceChallenge(true);
      return;
    }

    // Track hold start
    if (pose.gesture === currentChallenge.targetGesture && pose.status === "tracking") {
      if (holdStartRef.current === null) {
        holdStartRef.current = now;
      }
    } else if (currentChallenge.holdMs > 0) {
      // Reset hold if gesture lost (only for hold challenges)
      holdStartRef.current = null;
      setHoldProgress(0);
    }

    const result = checkPoseMatch(
      currentChallenge,
      pose.status === "tracking" ? pose.gesture : "IDLE",
      holdStartRef.current,
      now,
    );

    setHoldProgress(result.holdProgress);

    if (result.matched) {
      advanceChallenge(false);
    }
  }, [phase, currentChallenge, pose.gesture, pose.status, advanceChallenge]);

  // Timeout ticker for calibrate phase
  useEffect(() => {
    if (phase !== "calibrate" || advancingRef.current) return;

    const interval = setInterval(() => {
      if (!currentChallenge || advancingRef.current) return;
      const now = performance.now();
      if (now - challengeStartRef.current > currentChallenge.timeoutMs) {
        advanceChallenge(true);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [phase, currentChallenge, advanceChallenge]);

  // --- Phase 3: Ready ---
  useEffect(() => {
    if (phase !== "ready") return;
    triggerRain();
    const timeout = window.setTimeout(() => {
      onComplete();
    }, 3000);
    return () => clearTimeout(timeout);
  }, [phase, onComplete, triggerRain]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const detectText = bodyDetected ? "我看到你啦!" : "走到镜头前来!";
  const detectSubtext = bodyDetected ? "准备开始小游戏..." : "站到摄像头能看到你的地方";

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black">
      {/* Full-screen mirrored camera */}
      <video
        ref={videoRef}
        className="-scale-x-100 absolute inset-0 h-full w-full object-cover"
        autoPlay
        muted
        playsInline
      />

      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Skeleton overlay */}
      {cameraState === "ready" && (
        <SkeletonCanvas landmarksRef={pose.landmarksRef} opacity={skeletonOpacity} />
      )}

      {/* Confetti canvas */}
      <canvas
        ref={confettiCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ zIndex: 20 }}
      />

      {/* Skip button */}
      <button
        type="button"
        onClick={onSkip}
        className="absolute right-4 top-4 z-30 rounded-full bg-white/20 px-4 py-2 text-sm font-bold text-white backdrop-blur transition hover:bg-white/30"
      >
        跳过
      </button>

      {/* Phase 1: Detect */}
      {phase === "detect" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center">
          <div className="rounded-3xl bg-black/40 px-8 py-6 text-center backdrop-blur">
            <p className="animate-bounce text-5xl font-black text-white md:text-7xl">
              {detectText}
            </p>
            <p className="mt-3 text-xl font-bold text-white/80 md:text-2xl">
              {detectSubtext}
            </p>
          </div>
        </div>
      )}

      {/* Phase 2: Calibrate */}
      {phase === "calibrate" && currentChallenge && (
        <div className="absolute inset-0 z-20 flex items-end justify-center pb-12 md:items-center md:pb-0">
          {/* Dino instructor card - bottom center on mobile, center on desktop */}
          <div className="flex flex-col items-center gap-4">
            {/* Dino with speech bubble */}
            <div className="relative">
              <div className="rounded-3xl bg-white/90 px-8 py-5 text-center shadow-lg backdrop-blur">
                <p className="text-2xl md:text-3xl">{currentChallenge.emoji}</p>
                <p className="mt-2 text-3xl font-black text-[#2B5A8A] md:text-4xl">
                  {currentChallenge.instruction}
                </p>
              </div>
            </div>

            {/* Progress ring for hold challenges */}
            {currentChallenge.holdMs > 0 && holdProgress > 0 && (
              <div className="flex items-center gap-3">
                <div className="h-3 w-48 overflow-hidden rounded-full bg-white/30">
                  <div
                    className="h-full rounded-full bg-[#4ECDC4] transition-all duration-150"
                    style={{ width: `${holdProgress * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Challenge counter */}
            <div className="flex gap-2">
              {CHALLENGES.map((c, i) => (
                <div
                  key={c.id}
                  className={`h-3 w-3 rounded-full transition-all ${
                    i < challengeIdx
                      ? "bg-[#4ECDC4]"
                      : i === challengeIdx
                        ? "bg-white"
                        : "bg-white/30"
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Feedback text */}
          {feedbackText && (
            <div className="absolute left-1/2 top-1/4 -translate-x-1/2 -translate-y-1/2">
              <p className="animate-bounce text-5xl font-black text-white drop-shadow-lg md:text-7xl">
                {feedbackText}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Phase 3: Ready */}
      {phase === "ready" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6">
          <p className="animate-pulse text-5xl font-black text-white drop-shadow-lg md:text-7xl">
            开始冒险!
          </p>
          <button
            type="button"
            onClick={onComplete}
            className="rounded-full bg-[#FF8A5B] px-12 py-4 text-3xl font-black text-white shadow-[0_8px_0_#D8673D] transition hover:translate-y-[1px] hover:shadow-[0_7px_0_#D8673D] active:translate-y-[2px] active:shadow-[0_5px_0_#D8673D]"
          >
            出发!
          </button>
        </div>
      )}

      {/* Camera state fallback info */}
      {cameraState !== "ready" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4">
          <div className="rounded-3xl bg-black/50 px-8 py-6 text-center backdrop-blur">
            <p className="text-3xl font-black text-white">等待摄像头...</p>
            <p className="mt-2 text-lg text-white/70">请允许浏览器访问摄像头</p>
          </div>
          <button
            type="button"
            onClick={onSkip}
            className="rounded-full bg-white/20 px-6 py-3 text-lg font-bold text-white backdrop-blur transition hover:bg-white/30"
          >
            跳过，使用键盘模式
          </button>
        </div>
      )}
    </div>
  );
}

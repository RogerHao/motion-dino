import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

// Body-part color scheme (toddler-appealing)
const COLORS = {
  face: "#FFD93D",
  torso: "#FF6B6B",
  leftArm: "#4ECDC4",
  rightArm: "#45B7D1",
  leftLeg: "#96E6A1",
  rightLeg: "#DDA0DD",
} as const;

// Connection definitions: [fromIdx, toIdx, color]
const CONNECTIONS: [number, number, string][] = [
  // Face
  [7, 3, COLORS.face],   // left ear → left eye outer
  [3, 0, COLORS.face],   // left eye outer → nose
  [0, 6, COLORS.face],   // nose → right eye outer
  [6, 8, COLORS.face],   // right eye outer → right ear
  // Torso
  [11, 12, COLORS.torso], // left shoulder → right shoulder
  [11, 23, COLORS.torso], // left shoulder → left hip
  [12, 24, COLORS.torso], // right shoulder → right hip
  [23, 24, COLORS.torso], // left hip → right hip
  // Left arm
  [11, 13, COLORS.leftArm], // left shoulder → left elbow
  [13, 15, COLORS.leftArm], // left elbow → left wrist
  // Right arm
  [12, 14, COLORS.rightArm], // right shoulder → right elbow
  [14, 16, COLORS.rightArm], // right elbow → right wrist
  // Left leg
  [23, 25, COLORS.leftLeg], // left hip → left knee
  [25, 27, COLORS.leftLeg], // left knee → left ankle
  [27, 31, COLORS.leftLeg], // left ankle → left foot
  // Right leg
  [24, 26, COLORS.rightLeg], // right hip → right knee
  [26, 28, COLORS.rightLeg], // right knee → right ankle
  [28, 32, COLORS.rightLeg], // right ankle → right foot
];

// Joint indices to draw circles at
const JOINT_INDICES = [0, 3, 6, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];

interface DrawSkeletonOptions {
  lineWidth?: number;
  jointRadius?: number;
  minVisibility?: number;
  mirror?: boolean;
}

// Smoothing state (module-level, persists across frames)
let prevPositions: Map<number, { x: number; y: number }> = new Map();
const SMOOTH_FACTOR = 0.4; // 40% new, 60% previous

export function resetSmoothing(): void {
  prevPositions = new Map();
}

function getSmoothedPosition(
  idx: number,
  rawX: number,
  rawY: number,
): { x: number; y: number } {
  const prev = prevPositions.get(idx);
  if (!prev) {
    prevPositions.set(idx, { x: rawX, y: rawY });
    return { x: rawX, y: rawY };
  }
  const x = prev.x * (1 - SMOOTH_FACTOR) + rawX * SMOOTH_FACTOR;
  const y = prev.y * (1 - SMOOTH_FACTOR) + rawY * SMOOTH_FACTOR;
  prevPositions.set(idx, { x, y });
  return { x, y };
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  options?: DrawSkeletonOptions,
): void {
  const lineWidth = options?.lineWidth ?? 4;
  const jointRadius = options?.jointRadius ?? 5;
  const minVisibility = options?.minVisibility ?? 0.18;
  const mirror = options?.mirror ?? true;

  const toCanvas = (idx: number): { x: number; y: number; visible: boolean } | null => {
    const lm = landmarks[idx];
    if (!lm || (lm.visibility ?? 0) < minVisibility) return null;
    const rawX = mirror ? (1 - lm.x) * width : lm.x * width;
    const rawY = lm.y * height;
    const smoothed = getSmoothedPosition(idx, rawX, rawY);
    return { ...smoothed, visible: true };
  };

  // Draw connections with glow
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const [fromIdx, toIdx, color] of CONNECTIONS) {
    const from = toCanvas(fromIdx);
    const to = toCanvas(toIdx);
    if (!from || !to) continue;

    // Glow layer
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth + 4;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  // Draw joints
  for (const idx of JOINT_INDICES) {
    const pos = toCanvas(idx);
    if (!pos) continue;

    // White fill with dark stroke
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, jointRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

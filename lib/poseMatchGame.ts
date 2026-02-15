import type { PoseGesture } from "@/hooks/usePoseGesture";

export interface PoseChallenge {
  id: number;
  instruction: string;
  emoji: string;
  targetGesture: PoseGesture;
  holdMs: number;       // 0 = instant (single detection), >0 = must hold
  timeoutMs: number;
  successText: string;
  timeoutText: string;
}

export const CHALLENGES: PoseChallenge[] = [
  {
    id: 1,
    instruction: "站好不动!",
    emoji: "🧍",
    targetGesture: "IDLE",
    holdMs: 2000,
    timeoutMs: 6000,
    successText: "太棒了!",
    timeoutText: "不错哦!",
  },
  {
    id: 2,
    instruction: "跳起来!",
    emoji: "⬆️",
    targetGesture: "JUMP",
    holdMs: 0,
    timeoutMs: 8000,
    successText: "跳得真高!",
    timeoutText: "好样的!",
  },
  {
    id: 3,
    instruction: "蹲下去!",
    emoji: "⬇️",
    targetGesture: "DUCK",
    holdMs: 0,
    timeoutMs: 8000,
    successText: "蹲得真快!",
    timeoutText: "继续加油!",
  },
];

export interface MatchResult {
  matched: boolean;
  holdProgress: number; // 0-1 for hold challenges
}

export function checkPoseMatch(
  challenge: PoseChallenge,
  currentGesture: PoseGesture,
  holdStartTime: number | null,
  now: number,
): MatchResult {
  const gestureMatches = currentGesture === challenge.targetGesture;

  if (!gestureMatches) {
    return { matched: false, holdProgress: 0 };
  }

  if (challenge.holdMs === 0) {
    return { matched: true, holdProgress: 1 };
  }

  if (holdStartTime === null) {
    return { matched: false, holdProgress: 0 };
  }

  const held = now - holdStartTime;
  const progress = Math.min(1, held / challenge.holdMs);
  return { matched: progress >= 1, holdProgress: progress };
}

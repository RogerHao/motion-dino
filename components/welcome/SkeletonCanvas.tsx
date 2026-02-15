"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { drawSkeleton, resetSmoothing } from "@/lib/skeleton";

interface SkeletonCanvasProps {
  landmarksRef: RefObject<NormalizedLandmark[] | null>;
  opacity?: number;
}

export function SkeletonCanvas({ landmarksRef, opacity = 1 }: SkeletonCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    resetSmoothing();

    const loop = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const parent = canvas.parentElement;
      if (parent) {
        const { clientWidth, clientHeight } = parent;
        if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
          canvas.width = clientWidth;
          canvas.height = clientHeight;
        }
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const landmarks = landmarksRef.current;
      if (landmarks && landmarks.length >= 13) {
        ctx.globalAlpha = opacity;
        drawSkeleton(ctx, landmarks, canvas.width, canvas.height, {
          lineWidth: 4,
          jointRadius: 5,
          mirror: true,
        });
        ctx.globalAlpha = 1;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      resetSmoothing();
    };
  }, [landmarksRef, opacity]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 10 }}
    />
  );
}

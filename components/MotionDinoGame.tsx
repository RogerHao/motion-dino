"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePoseGesture } from "@/hooks/usePoseGesture";

type GameStatus = "ready" | "playing" | "crashed";
type GestureLabel = "IDLE" | "JUMP" | "DUCK";
type CameraState = "idle" | "ready" | "denied" | "unsupported";
type Scene = "prepare" | "game";

type ObstacleKind = "cactus" | "bird";

interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StarParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

interface RuntimeState {
  dinoY: number;
  dinoVelocity: number;
  ducking: boolean;
  speed: number;
  score: number;
  health: number;
  invincibleTimer: number;
  healTimer: number;
  obstacles: Obstacle[];
  spawnTimer: number;
  nextSpawnDelay: number;
  stars: StarParticle[];
}

// --- Sprite loading ---

interface SpriteSheet {
  dinoRun1: HTMLImageElement | null;
  dinoRun2: HTMLImageElement | null;
  dinoJump: HTMLImageElement | null;
  dinoDuck: HTMLImageElement | null;
  cactusSmall: HTMLImageElement | null;
  cactusBig: HTMLImageElement | null;
  bird1: HTMLImageElement | null;
  bird2: HTMLImageElement | null;
  cloud: HTMLImageElement | null;
  sun: HTMLImageElement | null;
  groundPattern: HTMLImageElement | null;
}

function loadSprite(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function loadAllSprites(): Promise<SpriteSheet> {
  return Promise.all([
    loadSprite("/assets/dino-run-1.png"),
    loadSprite("/assets/dino-run-2.png"),
    loadSprite("/assets/dino-jump.png"),
    loadSprite("/assets/dino-duck.png"),
    loadSprite("/assets/cactus-small.png"),
    loadSprite("/assets/cactus-big.png"),
    loadSprite("/assets/bird-1.png"),
    loadSprite("/assets/bird-2.png"),
    loadSprite("/assets/cloud.png"),
    loadSprite("/assets/sun.png"),
    loadSprite("/assets/ground-pattern.png"),
  ]).then(
    ([dinoRun1, dinoRun2, dinoJump, dinoDuck, cactusSmall, cactusBig, bird1, bird2, cloud, sun, groundPattern]) => ({
      dinoRun1,
      dinoRun2,
      dinoJump,
      dinoDuck,
      cactusSmall,
      cactusBig,
      bird1,
      bird2,
      cloud,
      sun,
      groundPattern,
    }),
  );
}

// --- Constants (tuned for toddlers) ---

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 360;
const GRAVITY = 1200;
const JUMP_FORCE = -620;
const BASE_SPEED = 150;
const MAX_SPEED = 240;
const DINO_X = 100;
const NORMAL_HEIGHT = 78;
const NORMAL_WIDTH = 62;
const DUCK_HEIGHT = 44;
const DUCK_WIDTH = 76;
const GROUND_RATIO = 0.78;
const RESTART_DELAY_MS = 2500;
const MAX_HEALTH = 5;
const HIT_INVINCIBLE_SECONDS = 1.35;
const AUTO_HEAL_INTERVAL_SECONDS = 11;
const DINO_HITBOX_SHRINK = 0.72;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function getSpeedGain(score: number): number {
  if (score < 200) return 0.8;
  if (score < 500) return 1.5;
  return 2.5;
}

function getSpawnDelay(score: number): [number, number] {
  if (score < 200) return [4.5, 6.0];
  if (score < 500) return [3.5, 5.0];
  return [3.0, 4.5];
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function createInitialRuntime(): RuntimeState {
  const groundY = CANVAS_HEIGHT * GROUND_RATIO;
  return {
    dinoY: groundY - NORMAL_HEIGHT,
    dinoVelocity: 0,
    ducking: false,
    speed: BASE_SPEED,
    score: 0,
    health: MAX_HEALTH,
    invincibleTimer: 0,
    healTimer: 0,
    obstacles: [],
    spawnTimer: 0,
    nextSpawnDelay: randomInRange(5.0, 6.5),
    stars: [],
  };
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function createCrashStars(x: number, y: number): StarParticle[] {
  return Array.from({ length: 12 }).map(() => {
    const angle = randomInRange(-Math.PI, Math.PI);
    const speed = randomInRange(80, 220);
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      life: randomInRange(0.55, 1),
      maxLife: 1,
    };
  });
}

export function MotionDinoGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const restartDeadlineRef = useRef<number>(0);
  const obstacleIdRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const displayedScoreRef = useRef(0);
  const displayedGestureRef = useRef<GestureLabel>("IDLE");
  const previousPoseGestureRef = useRef<GestureLabel>("IDLE");
  const runtimeRef = useRef<RuntimeState>(createInitialRuntime());
  const spritesRef = useRef<SpriteSheet | null>(null);
  const inputRef = useRef({
    jumpQueued: false,
    duckPressed: false,
    poseDuckActive: false,
  });

  const [status, setStatus] = useState<GameStatus>("ready");
  const [scene, setScene] = useState<Scene>("prepare");
  const [gesture, setGesture] = useState<GestureLabel>("IDLE");
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [health, setHealth] = useState(MAX_HEALTH);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [damageHint, setDamageHint] = useState<string | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const pose = usePoseGesture({
    enabled: cameraState === "ready" && (scene === "prepare" || status === "playing"),
    videoRef,
  });

  // Load sprites once
  useEffect(() => {
    loadAllSprites().then((sprites) => {
      spritesRef.current = sprites;
    });
  }, []);

  const resetGame = useCallback(() => {
    runtimeRef.current = createInitialRuntime();
    restartDeadlineRef.current = 0;
    displayedScoreRef.current = 0;
    displayedGestureRef.current = "IDLE";
    previousPoseGestureRef.current = "IDLE";
    inputRef.current.poseDuckActive = false;
    setScore(0);
    setHealth(MAX_HEALTH);
    setGesture("IDLE");
    setDamageHint(null);
    setStatus("playing");
  }, []);

  const enterGame = useCallback(() => {
    setScene("game");
    resetGame();
  }, [resetGame]);

  const returnToPreparation = useCallback(() => {
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    runtimeRef.current = createInitialRuntime();
    displayedScoreRef.current = 0;
    displayedGestureRef.current = "IDLE";
    previousPoseGestureRef.current = "IDLE";
    inputRef.current = {
      jumpQueued: false,
      duckPressed: false,
      poseDuckActive: false,
    };
    setScene("prepare");
    setStatus("ready");
    setScore(0);
    setHealth(MAX_HEALTH);
    setGesture("IDLE");
    setDamageHint(null);
    setMilestone(null);
  }, []);

  const triggerRestart = useCallback(() => {
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
    }
    restartDeadlineRef.current = performance.now() + RESTART_DELAY_MS;
    restartTimerRef.current = window.setTimeout(() => {
      resetGame();
    }, RESTART_DELAY_MS);
  }, [resetGame]);

  const getDinoRect = useCallback((state: RuntimeState) => {
    const dinoHeight = state.ducking ? DUCK_HEIGHT : NORMAL_HEIGHT;
    const dinoWidth = state.ducking ? DUCK_WIDTH : NORMAL_WIDTH;
    const shrinkWidth = dinoWidth * (1 - DINO_HITBOX_SHRINK);
    const shrinkHeight = dinoHeight * (1 - DINO_HITBOX_SHRINK);
    return {
      x: DINO_X + shrinkWidth / 2,
      y: state.dinoY + shrinkHeight / 2,
      width: dinoWidth - shrinkWidth,
      height: dinoHeight - shrinkHeight,
    };
  }, []);

  const updateAndRender = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      if (!lastTickRef.current) {
        lastTickRef.current = timestamp;
      }

      const dt = clamp((timestamp - lastTickRef.current) / 1000, 0, 0.05);
      lastTickRef.current = timestamp;
      const runtime = runtimeRef.current;
      const groundY = CANVAS_HEIGHT * GROUND_RATIO;
      const dinoHeight = runtime.ducking ? DUCK_HEIGHT : NORMAL_HEIGHT;
      const sprites = spritesRef.current;

      if (status === "playing") {
        runtime.invincibleTimer = Math.max(0, runtime.invincibleTimer - dt);
        runtime.healTimer += dt;
        if (runtime.health < MAX_HEALTH && runtime.healTimer >= AUTO_HEAL_INTERVAL_SECONDS) {
          runtime.health += 1;
          runtime.healTimer = 0;
          setHealth(runtime.health);
        }

        runtime.ducking =
          (inputRef.current.duckPressed || inputRef.current.poseDuckActive) &&
          runtime.dinoY >= groundY - NORMAL_HEIGHT - 1;

        const canJump = runtime.dinoY >= groundY - NORMAL_HEIGHT - 0.5;
        if (inputRef.current.jumpQueued && canJump) {
          runtime.dinoVelocity = JUMP_FORCE;
        }
        inputRef.current.jumpQueued = false;

        runtime.dinoY += runtime.dinoVelocity * dt;
        runtime.dinoVelocity += GRAVITY * dt;

        const floorY = runtime.ducking ? groundY - DUCK_HEIGHT : groundY - NORMAL_HEIGHT;
        if (runtime.dinoY > floorY) {
          runtime.dinoY = floorY;
          runtime.dinoVelocity = 0;
        }

        // Progressive speed gain
        const speedGain = getSpeedGain(runtime.score);
        runtime.speed = clamp(runtime.speed + speedGain * dt, BASE_SPEED, MAX_SPEED);

        runtime.spawnTimer += dt;
        if (runtime.spawnTimer >= runtime.nextSpawnDelay) {
          runtime.spawnTimer = 0;
          const [minDelay, maxDelay] = getSpawnDelay(runtime.score);
          runtime.nextSpawnDelay = randomInRange(minDelay, maxDelay);
          const allowBird = runtime.score > 600;
          const kind: ObstacleKind = allowBird && Math.random() > 0.90 ? "bird" : "cactus";
          if (kind === "cactus") {
            const big = Math.random() > 0.72;
            const width = big ? 40 : 30;
            const height = big ? 70 : 52;
            runtime.obstacles.push({
              id: obstacleIdRef.current++,
              kind,
              x: CANVAS_WIDTH + 30,
              y: groundY - height,
              width,
              height,
            });
          } else {
            const width = 56;
            const height = 36;
            runtime.obstacles.push({
              id: obstacleIdRef.current++,
              kind,
              x: CANVAS_WIDTH + 30,
              y: groundY - randomInRange(108, 126),
              width,
              height,
            });
          }
        }

        runtime.obstacles = runtime.obstacles
          .map((obstacle) => ({
            ...obstacle,
            x: obstacle.x - runtime.speed * dt,
          }))
          .filter((obstacle) => obstacle.x + obstacle.width > -20);

        const dinoRect = getDinoRect(runtime);
        let collidedObstacleId: number | null = null;
        for (const obstacle of runtime.obstacles) {
          const shrink = obstacle.kind === "bird" ? 0.48 : 0.40;
          const shrinkW = obstacle.width * shrink;
          const shrinkH = obstacle.height * shrink;
          const obstacleRect = {
            x: obstacle.x + shrinkW / 2,
            y: obstacle.y + shrinkH / 2,
            width: obstacle.width - shrinkW,
            height: obstacle.height - shrinkH,
          };

          if (intersects(dinoRect, obstacleRect) && runtime.invincibleTimer <= 0) {
            runtime.health = Math.max(0, runtime.health - 1);
            runtime.invincibleTimer = HIT_INVINCIBLE_SECONDS;
            runtime.healTimer = 0;
            runtime.stars = createCrashStars(DINO_X + 35, runtime.dinoY + 30);
            collidedObstacleId = obstacle.id;
            setHealth(runtime.health);
            if (runtime.health <= 0) {
              setDamageHint("休息一下，马上再来！");
              setStatus("crashed");
              triggerRestart();
            } else {
              setDamageHint(`轻轻碰到啦，还剩 ${runtime.health} 格能量`);
            }
            break;
          }
        }
        if (collidedObstacleId !== null) {
          runtime.obstacles = runtime.obstacles.filter((obstacle) => obstacle.id !== collidedObstacleId);
        }

        runtime.score += dt * 34;
        const currentScore = Math.floor(runtime.score);
        if (currentScore !== displayedScoreRef.current) {
          displayedScoreRef.current = currentScore;
          setScore(currentScore);
        }
        const nextGesture = runtime.ducking ? "DUCK" : runtime.dinoY < groundY - NORMAL_HEIGHT - 6 ? "JUMP" : "IDLE";
        if (nextGesture !== displayedGestureRef.current) {
          displayedGestureRef.current = nextGesture;
          setGesture(nextGesture);
        }

        if (currentScore > highScore) {
          setHighScore(currentScore);
          localStorage.setItem("motion-dino-high-score", String(currentScore));
        }

        if (currentScore > 0 && currentScore % 100 === 0) {
          setMilestone(currentScore);
        }
      }

      if (status === "crashed" || runtime.stars.length > 0) {
        runtime.stars = runtime.stars
          .map((star) => ({
            ...star,
            x: star.x + star.vx * dt,
            y: star.y + star.vy * dt,
            vy: star.vy + 260 * dt,
            life: star.life - dt,
          }))
          .filter((star) => star.life > 0);
      }

      // === RENDERING ===

      // Sky gradient
      const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
      sky.addColorStop(0, "#9FE8FF");
      sky.addColorStop(1, "#EFFFFA");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Sun (sprite or skip)
      if (sprites?.sun) {
        ctx.drawImage(sprites.sun, CANVAS_WIDTH - 110, 18, 80, 80);
      }

      // Mountains + Ground
      // Always draw mountains
      ctx.fillStyle = "#D5E7A4";
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.quadraticCurveTo(120, groundY - 70, 240, groundY);
      ctx.quadraticCurveTo(340, groundY - 80, 460, groundY);
      ctx.quadraticCurveTo(560, groundY - 62, 700, groundY);
      ctx.quadraticCurveTo(820, groundY - 76, 960, groundY);
      ctx.closePath();
      ctx.fill();

      if (sprites?.groundPattern) {
        // Yellow ground fill as safety behind sprite
        ctx.fillStyle = "#F6D665";
        ctx.fillRect(0, groundY, CANVAS_WIDTH, CANVAS_HEIGHT - groundY);
        // Sprite ground on top
        ctx.drawImage(sprites.groundPattern, 0, groundY, CANVAS_WIDTH, CANVAS_HEIGHT - groundY);
      } else {
        // Procedural ground fallback
        ctx.fillStyle = "#F6D665";
        ctx.fillRect(0, groundY, CANVAS_WIDTH, CANVAS_HEIGHT - groundY);
        ctx.fillStyle = "#E8BC45";
        ctx.fillRect(0, groundY + 5, CANVAS_WIDTH, 6);
      }

      // Clouds (sprite or procedural)
      const cloudOffset = (timestamp * 0.018) % (CANVAS_WIDTH + 240);
      const cloudXs = [120 - cloudOffset, 460 - cloudOffset, 810 - cloudOffset];
      for (const x of cloudXs) {
        const adjustedX = x < -140 ? x + CANVAS_WIDTH + 260 : x;
        if (sprites?.cloud) {
          ctx.drawImage(sprites.cloud, adjustedX, 40, 110, 36);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          drawRoundedRect(ctx, adjustedX, 55, 110, 36, 18);
          ctx.fill();
        }
      }

      // Obstacles (sprite or procedural)
      for (const obstacle of runtime.obstacles) {
        if (obstacle.kind === "cactus") {
          const cactusSprite = obstacle.height > 60 ? sprites?.cactusBig : sprites?.cactusSmall;
          if (cactusSprite) {
            ctx.drawImage(cactusSprite, obstacle.x, obstacle.y, obstacle.width, obstacle.height);
          } else {
            ctx.fillStyle = "#2CC96B";
            drawRoundedRect(ctx, obstacle.x, obstacle.y, obstacle.width, obstacle.height, 12);
            ctx.fill();
            ctx.fillStyle = "#1DAA57";
            drawRoundedRect(ctx, obstacle.x + 8, obstacle.y - 18, 10, 30, 6);
            ctx.fill();
            drawRoundedRect(ctx, obstacle.x + obstacle.width - 18, obstacle.y + 8, 10, 28, 6);
            ctx.fill();
          }
        } else {
          const birdFrame = Math.floor(timestamp / 200) % 2;
          const birdSprite = birdFrame === 0 ? sprites?.bird1 : sprites?.bird2;
          if (birdSprite) {
            ctx.drawImage(birdSprite, obstacle.x, obstacle.y, obstacle.width, obstacle.height);
          } else {
            const flap = Math.sin(timestamp / 90) * 4;
            ctx.fillStyle = "#9B5DE5";
            drawRoundedRect(ctx, obstacle.x, obstacle.y + 8, obstacle.width, obstacle.height - 8, 16);
            ctx.fill();
            ctx.fillStyle = "#B88DF0";
            drawRoundedRect(ctx, obstacle.x + 6, obstacle.y + flap, obstacle.width - 10, 10, 6);
            ctx.fill();
          }
        }
      }

      // Dino (sprite or procedural)
      const dinoWidth = runtime.ducking ? DUCK_WIDTH : NORMAL_WIDTH;
      const invFlicker = runtime.invincibleTimer > 0 && Math.floor(timestamp / 90) % 2 === 0;
      if (invFlicker) {
        ctx.save();
        ctx.globalAlpha = 0.45;
      }

      let dinoSprite: HTMLImageElement | null = null;
      if (sprites) {
        if (runtime.dinoY < groundY - NORMAL_HEIGHT - 6) {
          dinoSprite = sprites.dinoJump;
        } else if (runtime.ducking) {
          dinoSprite = sprites.dinoDuck;
        } else {
          const runFrame = Math.floor(timestamp / 150) % 2;
          dinoSprite = runFrame === 0 ? sprites.dinoRun1 : sprites.dinoRun2;
        }
      }

      if (dinoSprite) {
        ctx.drawImage(dinoSprite, DINO_X, runtime.dinoY, dinoWidth, dinoHeight);
      } else {
        // Procedural fallback
        ctx.fillStyle = "#2ECC71";
        drawRoundedRect(ctx, DINO_X, runtime.dinoY, dinoWidth, dinoHeight, 18);
        ctx.fill();

        ctx.fillStyle = "#F9E79F";
        drawRoundedRect(ctx, DINO_X + 8, runtime.dinoY + dinoHeight * 0.45, dinoWidth * 0.64, dinoHeight * 0.44, 12);
        ctx.fill();

        ctx.fillStyle = status === "crashed" ? "#E74C3C" : "#2B2D42";
        const eyeY = runtime.ducking ? runtime.dinoY + 12 : runtime.dinoY + 16;
        ctx.beginPath();
        ctx.arc(DINO_X + dinoWidth - 16, eyeY, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }

      if (invFlicker) {
        ctx.restore();
      }

      // Stars
      for (const star of runtime.stars) {
        ctx.save();
        ctx.globalAlpha = star.life / star.maxLife;
        ctx.fillStyle = "#FFD93D";
        ctx.beginPath();
        ctx.arc(star.x, star.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (status === "crashed") {
        drawRoundedRect(ctx, CANVAS_WIDTH / 2 - 160, 24, 320, 46, 20);
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.fill();
        ctx.fillStyle = "#FF6B6B";
        ctx.font = "700 22px system-ui";
        ctx.textAlign = "center";
        const remaining = Math.max(1, Math.ceil((restartDeadlineRef.current - performance.now()) / 1000));
        ctx.fillText(`休息一下，${remaining} 秒后再来！`, CANVAS_WIDTH / 2, 54);
      }
    },
    [getDinoRect, highScore, status, triggerRestart],
  );

  useEffect(() => {
    const stored = localStorage.getItem("motion-dino-high-score");
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) {
        const raf = window.requestAnimationFrame(() => setHighScore(parsed));
        return () => window.cancelAnimationFrame(raf);
      }
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (milestone === null) {
      return;
    }
    const timeout = window.setTimeout(() => setMilestone(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [milestone]);

  useEffect(() => {
    if (!damageHint) {
      return;
    }
    const timeout = window.setTimeout(() => setDamageHint(null), 1700);
    return () => window.clearTimeout(timeout);
  }, [damageHint]);

  useEffect(() => {
    const loop = (timestamp: number) => {
      updateAndRender(timestamp);
      rafRef.current = window.requestAnimationFrame(loop);
    };
    rafRef.current = window.requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updateAndRender]);

  useEffect(() => {
    if (scene !== "game" || status !== "playing") {
      inputRef.current.poseDuckActive = false;
      previousPoseGestureRef.current = "IDLE";
      return;
    }

    const poseTracking = pose.status === "tracking";
    const poseGesture = poseTracking ? pose.gesture : "IDLE";
    inputRef.current.poseDuckActive = poseGesture === "DUCK";

    if (poseGesture === "JUMP" && previousPoseGestureRef.current !== "JUMP") {
      inputRef.current.jumpQueued = true;
    }
    previousPoseGestureRef.current = poseGesture;
  }, [pose.gesture, pose.status, scene, status]);

  const canStartAdventure =
    cameraState === "denied" ||
    cameraState === "unsupported" ||
    (cameraState === "ready" && pose.status === "tracking");

  // Jump-to-start: auto-enter game when child jumps on prep screen
  const prepPrevGestureRef = useRef<string>("IDLE");
  useEffect(() => {
    if (scene !== "prepare") {
      prepPrevGestureRef.current = "IDLE";
      return;
    }
    const prev = prepPrevGestureRef.current;
    prepPrevGestureRef.current = pose.gesture;
    if (
      canStartAdventure &&
      pose.status === "tracking" &&
      pose.gesture === "JUMP" &&
      prev !== "JUMP"
    ) {
      enterGame();
    }
  }, [scene, canStartAdventure, pose.status, pose.gesture, enterGame]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.code;
      const jumpKeys = key === "Space" || key === "ArrowUp" || key === "KeyW";
      const duckKeys = key === "ArrowDown" || key === "KeyS";
      if (!jumpKeys && !duckKeys) {
        return;
      }
      event.preventDefault();

      if (jumpKeys && !event.repeat) {
        if (scene === "prepare") {
          if (canStartAdventure) {
            enterGame();
          }
          return;
        }
        if (status !== "playing") {
          return;
        }
        inputRef.current.jumpQueued = true;
      }

      if (duckKeys && scene === "game") {
        inputRef.current.duckPressed = true;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "ArrowDown" || event.code === "KeyS") {
        inputRef.current.duckPressed = false;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [canStartAdventure, enterGame, scene, status]);

  useEffect(() => {
    const shouldKeepCameraOn = scene === "prepare" || status === "playing";
    if (!shouldKeepCameraOn || cameraState === "ready" || streamRef.current) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      const raf = window.requestAnimationFrame(() => setCameraState("unsupported"));
      return () => window.cancelAnimationFrame(raf);
    }

    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraState("ready");
      })
      .catch(() => {
        setCameraState("denied");
      });

    return () => {
      cancelled = true;
    };
  }, [cameraState, scene, status]);

  useEffect(() => {
    if (!videoRef.current || !streamRef.current) {
      return;
    }
    if (videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraState, scene]);

  useEffect(() => {
    return () => {
      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const gestureLabel = useMemo(() => {
    if (gesture === "JUMP") {
      return "检测动作：跳一跳";
    }
    if (gesture === "DUCK") {
      return "检测动作：蹲一蹲";
    }
    return "检测动作：准备好啦";
  }, [gesture]);

  const gestureShortLabel = useMemo(() => {
    if (gesture === "JUMP") {
      return "跳跃";
    }
    if (gesture === "DUCK") {
      return "下蹲";
    }
    return "待机";
  }, [gesture]);

  const cameraLabel = useMemo(() => {
    if (cameraState === "ready") {
      return "摄像头已连接";
    }
    if (cameraState === "denied") {
      return "摄像头未授权，将自动切换为键盘模式";
    }
    if (cameraState === "unsupported") {
      return "当前浏览器不支持摄像头，可使用键盘游玩";
    }
    return "正在等待摄像头授权";
  }, [cameraState]);

  const preparationHint = useMemo(() => {
    if (cameraState === "idle") {
      return "先点击浏览器授权摄像头，系统会自动开始体感校准。";
    }
    if (cameraState === "ready" && pose.status === "calibrating") {
      return `站好别动... ${Math.round(pose.calibrationProgress * 100)}%`;
    }
    if (cameraState === "ready" && pose.status === "tracking") {
      return "跳一下就能开始！";
    }
    if (cameraState === "ready" && pose.status === "no-person") {
      return "走到镜头前面来！";
    }
    if (cameraState === "ready" && pose.status === "error") {
      return "体感模型初始化异常，可先用键盘开始游戏。";
    }
    if (cameraState === "denied" || cameraState === "unsupported") {
      return "已切换为键盘模式，按空格键开始。";
    }
    return "准备中...";
  }, [cameraState, pose.calibrationProgress, pose.status]);

  const healthIcons = useMemo(() => {
    return `${"❤".repeat(health)}${"♡".repeat(Math.max(0, MAX_HEALTH - health))}`;
  }, [health]);

  const healthPercent = useMemo(() => {
    return (health / MAX_HEALTH) * 100;
  }, [health]);

  const trackingTierLabel = useMemo(() => {
    if (pose.trackingTier === 1) return "全身";
    if (pose.trackingTier === 2) return "头部";
    return "肩部";
  }, [pose.trackingTier]);

  const poseStatusMeta = useMemo(() => {
    if (cameraState === "denied") {
      return {
        label: "体感：摄像头未授权（键盘模式）",
        borderColor: "#7B8DB8",
        panelBg: "#EAF1FF",
        panelText: "#3A5A94",
      };
    }
    if (cameraState === "unsupported") {
      return {
        label: "体感：浏览器不支持（键盘模式）",
        borderColor: "#7B8DB8",
        panelBg: "#EAF1FF",
        panelText: "#3A5A94",
      };
    }
    if (cameraState !== "ready") {
      return {
        label: "体感：等待开始",
        borderColor: "#9DB0CC",
        panelBg: "#EDF4FF",
        panelText: "#3A5A94",
      };
    }
    if (pose.status === "loading") {
      return {
        label: "体感：模型加载中",
        borderColor: "#D1A234",
        panelBg: "#FFF4D6",
        panelText: "#8D6400",
      };
    }
    if (pose.status === "calibrating") {
      return {
        label: `体感：校准中 ${Math.round(pose.calibrationProgress * 100)}%`,
        borderColor: "#D1A234",
        panelBg: "#FFF4D6",
        panelText: "#8D6400",
      };
    }
    if (pose.status === "tracking") {
      return {
        label: `体感：识别正常（${trackingTierLabel}）`,
        borderColor: "#31A866",
        panelBg: "#E7F9EE",
        panelText: "#1E7E49",
      };
    }
    if (pose.status === "no-person") {
      return {
        label: "体感：走到镜头前面来",
        borderColor: "#D95C5C",
        panelBg: "#FFE9E9",
        panelText: "#9D2F2F",
      };
    }
    if (pose.status === "error") {
      return {
        label: "体感：识别异常（键盘可玩）",
        borderColor: "#D95C5C",
        panelBg: "#FFE9E9",
        panelText: "#9D2F2F",
      };
    }
    return {
      label: "体感：准备中",
      borderColor: "#9DB0CC",
      panelBg: "#EDF4FF",
      panelText: "#3A5A94",
    };
  }, [cameraState, pose.calibrationProgress, pose.status, trackingTierLabel]);

  const showSilhouette = cameraState === "ready" && (pose.status === "no-person" || pose.status === "calibrating");

  const cameraReady = cameraState === "ready";
  const poseTracking = cameraReady && pose.status === "tracking";
  const poseCalibrating = cameraReady && pose.status === "calibrating";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#8EDBFF_0%,#E8FFF5_45%,#FFF6CE_100%)] px-4 py-4 md:px-8 md:py-6">
      <div className={scene === "prepare" ? "mx-auto w-full max-w-6xl" : "mx-auto w-full"}>
        {scene === "prepare" ? (
          <div className="flex min-h-[calc(100vh-2rem)] items-center">
            <div className="w-full rounded-[34px] border-4 border-white/90 bg-white/75 p-5 shadow-2xl backdrop-blur md:p-8">
              <div className="text-center">
                <h1 className="text-4xl font-black tracking-wide text-[#1F5C9A] md:text-6xl">小恐龙准备好了吗？</h1>
                <p className="mt-3 text-lg font-semibold text-[#345978] md:text-2xl">跟着画面站好就能玩啦！</p>
              </div>

              <div className="mt-6 grid gap-5 md:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  {/* Icon cards */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className={`flex flex-col items-center rounded-3xl border-2 px-4 py-5 text-center ${cameraReady ? "border-[#31A866] bg-[#E7F9EE]" : "border-[#D1A234] bg-[#FFF4D6]"}`}>
                      <span className="text-4xl">{cameraReady ? "📷" : "📷"}</span>
                      <span className={`mt-2 text-lg font-black ${cameraReady ? "text-[#1E7E49]" : "text-[#8D6400]"}`}>
                        {cameraReady ? "✓ 摄像头" : "摄像头"}
                      </span>
                    </div>
                    <div className={`flex flex-col items-center rounded-3xl border-2 px-4 py-5 text-center ${poseTracking ? "border-[#31A866] bg-[#E7F9EE]" : poseCalibrating ? "border-[#D1A234] bg-[#FFF4D6]" : "border-[#9DB0CC] bg-[#EDF4FF]"}`}>
                      <span className="text-4xl">🧍</span>
                      <span className={`mt-2 text-lg font-black ${poseTracking ? "text-[#1E7E49]" : poseCalibrating ? "text-[#8D6400]" : "text-[#3A5A94]"}`}>
                        {poseTracking ? "✓ 体感" : poseCalibrating ? `${Math.round(pose.calibrationProgress * 100)}%` : "体感"}
                      </span>
                    </div>
                    <div className={`flex flex-col items-center rounded-3xl border-2 px-4 py-5 text-center ${canStartAdventure ? "border-[#FF8A5B] bg-[#FFF0E8]" : "border-[#9DB0CC] bg-[#EDF4FF]"}`}>
                      <span className="text-4xl">🚀</span>
                      <span className={`mt-2 text-lg font-black ${canStartAdventure ? "text-[#D8673D]" : "text-[#3A5A94]"}`}>
                        {canStartAdventure ? "出发！" : "等待中"}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-3xl border-2 border-white bg-[#FFFDF4] p-4">
                    <p className="text-lg font-bold text-[#5E7489]">{preparationHint}</p>
                    <p className="mt-2 text-sm font-semibold text-[#8B9DAE]">（按空格键也能跳）</p>
                  </div>
                </div>

                <div className="rounded-3xl border-2 border-white bg-[#F7FBFF] p-4">
                  <div className="text-lg font-black text-[#345978]">摄像头预览（镜像）</div>
                  <div className="relative mt-3 overflow-hidden rounded-2xl border-4 bg-[#1C2B3A]" style={{ borderColor: poseStatusMeta.borderColor }}>
                    <video ref={videoRef} className="-scale-x-100 h-[320px] w-full object-cover md:h-[360px]" autoPlay muted playsInline />
                    {showSilhouette && (
                      <img
                        src="/assets/silhouette-guide.png"
                        alt=""
                        className="pointer-events-none absolute inset-0 m-auto h-3/4 w-auto animate-pulse opacity-40"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )}
                  </div>
                  <div className="mt-3 rounded-2xl px-4 py-3 text-base font-bold" style={{ backgroundColor: poseStatusMeta.panelBg, color: poseStatusMeta.panelText }}>
                    {poseStatusMeta.label}
                  </div>
                  {pose.errorMessage && (
                    <div className="mt-3 rounded-2xl bg-[#FFF1F1] px-4 py-3 text-sm font-semibold text-[#AE3F3F]">
                      模型信息：{pose.errorMessage}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 flex flex-col items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={enterGame}
                  disabled={!canStartAdventure}
                  className="inline-flex min-h-16 min-w-56 items-center justify-center rounded-full bg-[#FF8A5B] px-10 py-3 text-2xl font-black text-white shadow-[0_8px_0_#D8673D] transition enabled:hover:translate-y-[1px] enabled:hover:shadow-[0_7px_0_#D8673D] enabled:active:translate-y-[2px] enabled:active:shadow-[0_5px_0_#D8673D] disabled:cursor-not-allowed disabled:bg-[#F0A78A] disabled:shadow-none"
                >
                  开始冒险
                </button>
                <p className="text-sm font-semibold text-[#5E7489]">进入游戏后有 5 格能量，碰到障碍不会立刻结束，还会慢慢自动回血。</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-[34px] border-4 border-white/90 bg-[#EFF9FF] p-3 shadow-2xl">
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className="h-[82vh] min-h-[420px] w-full rounded-[28px] border-4 border-white/90 bg-[#d8f3ff]"
            />

            <div className="pointer-events-none absolute left-5 top-5 flex flex-wrap items-start gap-3">
              <div data-testid="score-value" className="rounded-3xl bg-[#FFF2BD]/95 px-5 py-3 text-4xl font-black text-[#B05A00] shadow">
                分数 {score}
              </div>
              <div className="rounded-3xl bg-[#DFF8E7]/95 px-5 py-3 text-2xl font-black text-[#208F4F] shadow">最高分 {highScore}</div>
              <div
                data-testid="game-status"
                className="rounded-3xl px-5 py-3 text-xl font-black shadow"
                style={{ backgroundColor: status === "crashed" ? "#FFE9E9" : "#EAF1FF", color: status === "crashed" ? "#A54040" : "#3655A3" }}
              >
                {status === "crashed" ? "休息一下" : "奔跑中"}
              </div>
              <div className="rounded-3xl bg-[#FFE5EE]/95 px-5 py-3 text-xl font-black text-[#B54870] shadow">
                能量 {healthIcons}
                <div className="mt-2 h-2.5 w-40 rounded-full bg-white/70">
                  <div className="h-full rounded-full bg-[#FF6EA8]" style={{ width: `${healthPercent}%` }} />
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute right-5 top-5 max-w-[320px] rounded-3xl px-5 py-3 text-xl font-black shadow" style={{ backgroundColor: poseStatusMeta.panelBg, color: poseStatusMeta.panelText }}>
              {poseStatusMeta.label}
            </div>

            <div className="pointer-events-none absolute bottom-5 left-5 rounded-3xl bg-white/85 px-5 py-3 text-xl font-black text-[#2B5A8A] shadow">
              {gestureLabel}（{gestureShortLabel}）
            </div>

            {damageHint && status === "playing" && (
              <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-3xl bg-white/92 px-6 py-3 text-xl font-black text-[#A24A3C] shadow">
                {damageHint}
              </div>
            )}

            {cameraState === "ready" ? (
              <div className="absolute bottom-5 right-5 w-56 rounded-3xl border-4 bg-[#1C2B3A] shadow-lg" style={{ borderColor: poseStatusMeta.borderColor }}>
                <video ref={videoRef} className="-scale-x-100 h-40 w-full rounded-[18px] object-cover" autoPlay muted playsInline />
                {/* Tracking tier badge */}
                {pose.status === "tracking" && (
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-0.5 text-xs font-bold text-white">
                    {trackingTierLabel}
                  </div>
                )}
              </div>
            ) : (
              <div className="pointer-events-none absolute bottom-5 right-5 max-w-64 rounded-3xl bg-white/90 px-4 py-3 text-base font-bold text-[#44607A] shadow">
                {cameraLabel}
              </div>
            )}

            <button
              type="button"
              onClick={returnToPreparation}
              className="absolute right-5 top-24 rounded-full bg-white/90 px-5 py-2 text-lg font-black text-[#3A5A94] shadow transition hover:bg-white"
            >
              重新校准
            </button>

            {milestone !== null && (
              <div className="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 rounded-full bg-[#FFF3B4] px-6 py-3 text-2xl font-black text-[#B56700] shadow">
                太棒了！达到 {milestone} 分
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

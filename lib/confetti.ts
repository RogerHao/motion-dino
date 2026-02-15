export type ConfettiShape = "circle" | "square" | "triangle";

export interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  size: number;
  life: number;
  maxLife: number;
  shape: ConfettiShape;
}

const RAINBOW = ["#FF6B6B", "#FFD93D", "#4ECDC4", "#45B7D1", "#96E6A1", "#DDA0DD", "#FF8A5B", "#A78BFA"];
const SHAPES: ConfettiShape[] = ["circle", "square", "triangle"];

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function createConfettiBurst(cx: number, cy: number, count = 30): ConfettiParticle[] {
  return Array.from({ length: count }, () => {
    const angle = randomInRange(-Math.PI, Math.PI);
    const speed = randomInRange(150, 400);
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 100,
      rotation: randomInRange(0, Math.PI * 2),
      rotationSpeed: randomInRange(-8, 8),
      color: pickRandom(RAINBOW),
      size: randomInRange(5, 10),
      life: randomInRange(0.8, 1.4),
      maxLife: 1.4,
      shape: pickRandom(SHAPES),
    };
  });
}

export function createConfettiRain(canvasWidth: number, count = 50): ConfettiParticle[] {
  return Array.from({ length: count }, () => ({
    x: randomInRange(0, canvasWidth),
    y: randomInRange(-200, -20),
    vx: randomInRange(-30, 30),
    vy: randomInRange(120, 300),
    rotation: randomInRange(0, Math.PI * 2),
    rotationSpeed: randomInRange(-6, 6),
    color: pickRandom(RAINBOW),
    size: randomInRange(5, 10),
    life: randomInRange(1.5, 3.0),
    maxLife: 3.0,
    shape: pickRandom(SHAPES),
  }));
}

export function updateConfetti(particles: ConfettiParticle[], dt: number): ConfettiParticle[] {
  return particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vy: p.vy + 300 * dt, // gravity
      rotation: p.rotation + p.rotationSpeed * dt,
      life: p.life - dt,
    }))
    .filter((p) => p.life > 0);
}

export function drawConfetti(ctx: CanvasRenderingContext2D, particles: ConfettiParticle[]): void {
  for (const p of particles) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.globalAlpha = Math.min(1, p.life / (p.maxLife * 0.3));
    ctx.fillStyle = p.color;

    if (p.shape === "circle") {
      ctx.beginPath();
      ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.shape === "square") {
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    } else {
      // triangle
      ctx.beginPath();
      ctx.moveTo(0, -p.size / 2);
      ctx.lineTo(-p.size / 2, p.size / 2);
      ctx.lineTo(p.size / 2, p.size / 2);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }
}

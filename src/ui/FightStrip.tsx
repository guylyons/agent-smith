import { useEffect, useRef } from "react";
import { createFight, stepFight, resizeFight, stillFight, mulberry32, type World } from "./fight";
import { makeScene, drawFight, type Scene } from "./fight-draw";

// The fight strip across the top of THE LINE: a strip of Nostromo corridor
// where Ripley and a xenomorph go at it, a new random round each time. The
// rules live in fight.ts; this only draws them on a canvas, one art pixel to a
// SCALE×SCALE block of screen, and keeps the loop from running when nobody can
// see it (tab hidden, scrolled away). Under prefers-reduced-motion it draws one
// still frame and never starts the loop. Decorative: hidden from screen readers.

const SCALE = 2;
const ART_H = 32;

export function FightStrip() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current, cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!wrap || !cv || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sprites = new Map<string, HTMLCanvasElement>();
    let world: World | null = null;
    let scene: Scene | null = null;
    let raf = 0, last = 0, onScreen = true;

    function fit() {
      const artW = Math.max(90, Math.floor(wrap!.clientWidth / SCALE));
      const dpr = window.devicePixelRatio || 1;
      cv!.width = Math.round(artW * SCALE * dpr);
      cv!.height = Math.round(ART_H * SCALE * dpr);
      cv!.style.width = `${artW * SCALE}px`;
      cv!.style.height = `${ART_H * SCALE}px`;
      scene = makeScene(artW, ART_H, SCALE * dpr);
      if (reduce.matches) world = stillFight(artW, ART_H);
      else if (world) resizeFight(world, artW, ART_H);
      else world = createFight(artW, ART_H, mulberry32(Date.now() >>> 0));
      drawFight(ctx!, world, scene, sprites);
    }

    function tick(ts: number) {
      raf = 0;
      if (!world || !scene) return;
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      stepFight(world, dt);
      drawFight(ctx!, world, scene, sprites);
      schedule();
    }
    function schedule() {
      if (raf || reduce.matches || document.hidden || !onScreen) return;
      raf = requestAnimationFrame(tick);
    }
    function halt() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
    function wake() { halt(); schedule(); }
    function onMotion() { halt(); world = null; fit(); schedule(); }

    const ro = new ResizeObserver(() => fit());
    ro.observe(wrap);
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); });
    io.observe(wrap);
    document.addEventListener("visibilitychange", wake);
    reduce.addEventListener("change", onMotion);
    fit();
    schedule();
    return () => {
      halt(); ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", wake);
      reduce.removeEventListener("change", onMotion);
    };
  }, []);

  return (
    <div className="fight" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

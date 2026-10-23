import { eyePoses, REST_GAZE, liveliness, blinkScale } from "./face";
import { SHAPES } from "./skins";
import { closedPath, toPoints, radiusAtAngle } from "./shape";

/** Version 1: keep this mapping stable; persisted seeds must never change their appearance. */
export function bloubAppearance(seed?: string) {
  const valid = seed && /^[0-9a-f]{32}$/.test(seed) ? seed : undefined;
  const byte = (i: number) => valid ? parseInt(valid.slice(i * 2, i * 2 + 2), 16) : 0;
  const shape = SHAPES[valid ? byte(6) % SHAPES.length : 0];
  return {
    body: closedPath(toPoints({ radii: shape.radii, cx: 0, cy: 0, sx: 1, sy: 1, rot: 0 }, 100)),
    radii: shape.radii,
    ink: valid ? `rgb(${[0, 1, 2].map(i => 24 + byte(i) % 88).join(",")})` : "#0a0a0c",
    paper: valid ? `rgb(${[3, 4, 5].map(i => 205 + byte(i) % 36).join(",")})` : "#e7e9ea",
    gaze: valid ? { yaw: 15 + byte(7) / 14, pitch: 5 + byte(8) / 12, roll: -13 } : REST_GAZE,
    width: valid ? 14 + byte(9) / 26 : 18.6,
    height: valid ? 30 + byte(10) / 13 : 41.2,
    split: valid ? 13 + byte(11) / 36 : 15.46,
    phase: valid ? byte(12) / 10 : 0,
  };
}

export function bloubEyes(appearance: ReturnType<typeof bloubAppearance>, time?: number) {
  const life = time === undefined ? null : liveliness(time + appearance.phase);
  const poses = eyePoses({
    yaw: appearance.gaze.yaw + (life?.dYaw ?? 0),
    pitch: appearance.gaze.pitch + (life?.dPitch ?? 0),
    roll: appearance.gaze.roll + (life?.dRoll ?? 0),
  }, 100, appearance.split);
  const k = life ? blinkScale(life.lid) : 1;
  return poses.map(eye => {
    const fit = radiusAtAngle(appearance.radii, Math.atan2(eye.y, eye.x));
    return `matrix(${eye.a},${eye.b * k},${eye.c},${eye.d * k},${eye.x * fit},${eye.y * fit})`;
  });
}

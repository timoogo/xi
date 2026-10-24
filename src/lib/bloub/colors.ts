import { COLORS, type ColorId } from "bloub-react";

/**
 * Body colours offered to owners: only those on which the white eyes stay visible
 * (WCAG contrast ≥ 3:1 for graphical objects). Black (encre) remains the default.
 */
export const MIN_EYE_CONTRAST = 3;
const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export function luminance(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
export const EYE_COLOR = "#ffffff";
export const READABLE_COLORS = COLORS.filter(color => contrast(color.hex, EYE_COLOR) >= MIN_EYE_CONTRAST);
export const COLOR_LABELS: Record<ColorId, string> = {
  encre: "Encre", creme: "Crème", brun: "Brun", rouge: "Rouge", orange: "Orange", ambre: "Ambre", vert: "Vert", turquoise: "Turquoise", bleu: "Bleu", violet: "Violet", rose: "Rose", gris: "Gris",
};

import type { SVGProps } from "react";

export function XiLogo({ size = 28, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} role="img" aria-label="Xi" {...props}>
      <path d="M4 4h16M6 12h12M4 20h16" />
    </svg>
  );
}

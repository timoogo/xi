"use client";

import { BloubAvatar } from "./bloub-avatar";
import Image from "next/image";
import { useState } from "react";

export function UserAvatar({ image, name, size = 56, bloubSeed }: { ai?: boolean; bloubSeed?: string | null; image?: string | null; name: string; size?: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const safeImage = image && (/^https:\/\//i.test(image) || /^\/(?!\/)/.test(image));
  if (bloubSeed) return <BloubAvatar name={name} size={size} seed={bloubSeed} />;
  if (safeImage && failedImage !== image) {
    return <Image src={image} alt={`${name}'s avatar`} width={size} height={size} unoptimized referrerPolicy="no-referrer" onError={() => setFailedImage(image)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return <BloubAvatar name={name} size={size} />;
}

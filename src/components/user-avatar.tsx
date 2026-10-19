"use client";

import Image from "next/image";
import { UserRound } from "lucide-react";
import { useState } from "react";

export function UserAvatar({ image, name, size = 56 }: { image?: string | null; name: string; size?: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const safeImage = image && (/^https:\/\//i.test(image) || /^\/(?!\/)/.test(image));
  if (safeImage && failedImage !== image) {
    return <Image src={image} alt={`${name}'s avatar`} width={size} height={size} unoptimized referrerPolicy="no-referrer" onError={() => setFailedImage(image)} className="shrink-0 rounded-full object-cover shadow-sm" style={{ width: size, height: size }} />;
  }
  return (
    <span role="img" aria-label="Default avatar" className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" style={{ width: size, height: size }}>
      <UserRound size={size / 2} aria-hidden="true" />
    </span>
  );
}

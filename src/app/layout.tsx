import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/themes/theme-provider";
import { SonnerToaster } from "@/lib/providers/toaster";


const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ξ | Votre espace privé",
  description: "Ξ (Xi) — votre espace privé de veille personnelle.",
  openGraph: {
    title: "Ξ | Votre espace privé",
    description: "Votre espace Ξ privé.",
    siteName: "Xi",
    locale: "fr_FR",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Ξ | Votre espace privé",
    description: "Votre espace Ξ privé.",
  },
  icons: { icon: "/xi.svg", apple: "/xi.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <SonnerToaster />
          </ThemeProvider>
      </body>
    </html>
  );
}

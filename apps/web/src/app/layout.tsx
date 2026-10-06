import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "../styles/globals.css";
import "../styles/layout-system.css";
import "../styles/vertto-brand.css";
import { getBrandConfig } from "../lib/brand";

const presentationModeBootstrap = `
  try {
    document.documentElement.dataset.presentationMode =
      window.localStorage.getItem("wpptrack-presentation-mode") === "true"
        ? "active"
        : "inactive";
  } catch {
    document.documentElement.dataset.presentationMode = "inactive";
  }
`;

export function generateMetadata(): Metadata {
  const brand = getBrandConfig();

  return {
    title: brand.name,
    description: `${brand.name} - cockpit de WhatsApp, trafego e conversoes para clientes finais.`,
    icons: {
      icon: brand.faviconUrl ?? "/favicon.svg",
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const brand = getBrandConfig();
  const brandStyle = {
    "--brand-primary": brand.primaryColor,
  } as CSSProperties;

  return (
    <html lang="pt-BR" data-brand-name={brand.name} suppressHydrationWarning style={brandStyle}>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: presentationModeBootstrap }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

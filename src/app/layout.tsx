import type { Metadata } from "next";
import { Instrument_Sans, Martian_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

// THE TYPE (Sep 20 2026): a trading cockpit is numbers first. Martian Mono carries every number, label and
// chip — wide, tabular, unmistakably a terminal; Instrument Sans carries the prose. Both load from
// next/font (no layout shift). Do NOT point --font-sans at an undefined variable (that was the serif bug).
const sans = Instrument_Sans({ variable: "--font-sans-face", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const mono = Martian_Mono({ variable: "--font-mono-face", subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "Esbueno Trades",
  description: "Futures trading room and options desk — live account, orders, system health",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Dark by default: every page component was written for a dark surface (white/6% borders,
    // emerald-400 text) while the root palette was light, which is why borders vanished and
    // green read as pastel. Remove "dark" here to flip the whole admin back to light.
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} dark h-full antialiased`}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0f1116" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Esbueno Trades" />
      </head>
      <body className="h-full flex bg-background">
        <ClerkProvider
          proxyUrl="/__clerk"
          appearance={{ variables: { colorPrimary: "#e2b64a" }, elements: { card: "bg-[#0f1116] border border-white/10" } }}
        >
          <Sidebar />
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <TopBar />
            <main className="flex-1 overflow-auto">
              <div className="page mx-auto w-full max-w-[1440px] p-4 md:p-6">
                {children}
              </div>
            </main>
          </div>
        </ClerkProvider>
      </body>
    </html>
  );
}

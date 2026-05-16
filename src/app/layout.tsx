import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

const hasClerkKeys = !!(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Esbueno Trades — Multi-Asset Trading Dashboard",
  description: "Unified multi-asset dashboard — Alpaca stocks/options + Tradovate futures with AI-powered trading agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#10b981" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Esbueno Trades" />
      </head>
      <body className="h-full flex bg-background">
        {hasClerkKeys ? (
          <ClerkProvider appearance={{ variables: { colorPrimary: "#3b82f6" }, elements: { card: "bg-[#0a0a0f] border border-white/10" } }}>
            <Sidebar />
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <TopBar />
              <main className="flex-1 overflow-auto pt-0 md:pt-0 pl-0">
                <div className="p-5 animate-fade-up">
                  {children}
                </div>
              </main>
            </div>
          </ClerkProvider>
        ) : (
          <>
            <Sidebar />
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <TopBar />
              <main className="flex-1 overflow-auto pt-0 md:pt-0 pl-0">
                <div className="p-5 animate-fade-up">
                  {children}
                </div>
              </main>
            </div>
          </>
        )}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Esbueno Trades",
  description: "Kraken margin desk — live account, paper record, orders, system health",
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
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#111318" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Esbueno Trades" />
      </head>
      <body className="h-full flex bg-background">
        <ClerkProvider
          proxyUrl="/__clerk"
          appearance={{ variables: { colorPrimary: "#3b82f6" }, elements: { card: "bg-[#0a0a0f] border border-white/10" } }}
        >
          <Sidebar />
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <TopBar />
            <main className="flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6 animate-fade-up">
                {children}
              </div>
            </main>
          </div>
        </ClerkProvider>
      </body>
    </html>
  );
}

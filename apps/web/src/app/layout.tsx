import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Homglai Service Core",
  description: "Coffee Machine Repair and Service Management System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-900 text-neutral-100 antialiased font-sans">
        {children}
      </body>
    </html>
  );
}

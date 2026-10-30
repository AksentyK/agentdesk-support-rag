import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AgentDesk · Support RAG Lab",
  description: "Лаборатория AI-поддержки: документы, поиск и сравнение моделей",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}

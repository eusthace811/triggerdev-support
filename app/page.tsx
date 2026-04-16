import { Chat } from "./components/chat";
import Image from "next/image";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-3 shrink-0 flex items-center gap-3">
        <Image src="/logo.svg" alt="Trigger.dev" width={120} height={21} priority />
        <span className="text-sm font-medium text-muted-foreground border border-zinc-700 rounded px-1.5 py-0.5 leading-tight">
          Support
        </span>
        <div className="ml-auto">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-zinc-500 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12H19M12 5l7 7-7 7"/>
            </svg>
            New chat
          </a>
        </div>
      </header>
      <Chat />
    </div>
  );
}

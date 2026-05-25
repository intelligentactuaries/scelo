// Top-level router for the Scelo renderer. Routes :
//   * `/`              — chat home (browser only; the Electron IDE
//                        redirects to /welcome via the isDesktopIDE check)
//   * `/c/:id`         — chat thread
//   * `/welcome`       — IDE welcome page (recent workspaces, sample
//                        scaffolds, configure-AI shortcut)
//   * `/workspace`     — the three-pane editor / files / terminal IDE
//   * `/swarm`         — full-window swarm-council surface
//   * `/dashboards/scelo` — soft → tools → hard brain layer (the only
//                        dashboard reachable in this repo; the IA
//                        monorepo exposes the wider specialist set)
//   * `/settings/*`    — AI providers, datasets, workspaces
//   * `/runtime-check` — bundled-stack diagnostics

import { Navigate, Route, Routes } from "react-router-dom";
import DashboardsShell from "./components/DashboardsShell";
import FirstRunAIPrompt from "./components/FirstRunAIPrompt";
import { isDesktopIDE } from "./lib/sceloIDE";
import ChatHome from "./routes/ChatHome";
import ChatRoute from "./routes/ChatRoute";
import RuntimeCheck from "./routes/RuntimeCheck";
import SettingsAI from "./routes/SettingsAI";
import SettingsData from "./routes/SettingsData";
import SettingsWorkspaces from "./routes/SettingsWorkspaces";
import Swarm from "./routes/Swarm";
import Welcome from "./routes/Welcome";
import Workspace from "./routes/Workspace";

export default function App() {
  // Inside the Electron IDE we deliberately bypass the chat-first home.
  // The IDE shows: Workspace, Scelo (soft → tools → hard), Swarm,
  // and Settings. Browser preview gets the chat home at /.
  const desktop = isDesktopIDE();
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <FirstRunAIPrompt />
      <Routes>
        <Route
          path="/"
          element={desktop ? <Navigate to="/welcome" replace /> : <ChatHome />}
        />
        <Route path="/c/:conversationId" element={<ChatRoute />} />

        {/* Brain layer — soft → tools → hard. The DashboardsShell
            redirects any other /dashboards/* path to /dashboards/scelo. */}
        <Route path="/dashboards/*" element={<DashboardsShell />} />

        {/* Scelo IDE first-run stack validation. Reachable in a regular
            browser too, but only meaningful inside the desktop shell where
            window.scelo is exposed by the Electron preload. */}
        <Route path="/runtime-check" element={<RuntimeCheck />} />

        {/* AI providers — bring your own key for Anthropic / OpenAI /
            Gemini / OpenAI-compat endpoints. Default stays Ollama. */}
        <Route path="/settings/ai" element={<SettingsAI />} />

        {/* Optional data downloads (IBTrACS for the climada Tool, etc.). */}
        <Route path="/settings/data" element={<SettingsData />} />

        {/* Multi-workspace registry — list + switch + remove. */}
        <Route path="/settings/workspaces" element={<SettingsWorkspaces />} />

        {/* IDE welcome — recent workspaces, sample scaffolds, primary
            actions. /workspace redirects here when no workspace has been
            opened yet. */}
        <Route path="/welcome" element={<Welcome />} />

        {/* Scelo IDE workspace — three-pane file browser + Monaco editor
            + xterm terminal. Only fully functional inside the desktop
            shell where window.scelo exposes fs / exec / workspace. */}
        <Route path="/workspace" element={<Workspace />} />

        {/* Swarm — full-window surface iframing the in-repo Scelo-
            integrated swarm at localhost:5190. */}
        <Route path="/swarm" element={<Swarm />} />
      </Routes>
    </div>
  );
}

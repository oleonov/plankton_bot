import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SSEProvider } from "./api/sse.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { Layout } from "./components/Layout.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Positions } from "./pages/Positions.tsx";
import { OrdersFills } from "./pages/OrdersFills.tsx";
import { PositionCycles } from "./pages/PositionCycles.tsx";
import { SelectionRules } from "./pages/SelectionRules.tsx";
import { RiskEvents } from "./pages/RiskEvents.tsx";
import { ControlCenter } from "./pages/ControlCenter.tsx";
import { Profiles } from "./pages/Profiles.tsx";
import { ProfileDetail } from "./pages/ProfileDetail.tsx";
import { ProfileOrders } from "./pages/ProfileOrders.tsx";
import { ProfilePositions } from "./pages/ProfilePositions.tsx";
import { ProfileFills } from "./pages/ProfileFills.tsx";
import { RiskSettings } from "./pages/RiskSettings.tsx";
import { ExecutionSettings } from "./pages/ExecutionSettings.tsx";
import { ProfileSettings } from "./pages/ProfileSettings.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Debug } from "./pages/Debug.tsx";
import { Status } from "./pages/status/Status.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <SSEProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Navigate to="/overview" replace />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/positions" element={<Positions />} />
                <Route path="/orders" element={<OrdersFills />} />
                <Route path="/pnl" element={<PositionCycles />} />
                <Route path="/families" element={<Navigate to="/selection-rules" replace />} />
                <Route path="/selection-rules" element={<SelectionRules />} />
                <Route path="/risk" element={<RiskEvents />} />
                <Route path="/control" element={<ControlCenter />} />
                <Route path="/profiles" element={<Profiles />} />
                <Route path="/profiles/:profileId" element={<ProfileDetail />} />
                <Route path="/profiles/:profileId/orders" element={<ProfileOrders />} />
                <Route path="/profiles/:profileId/positions" element={<ProfilePositions />} />
                <Route path="/profiles/:profileId/fills" element={<ProfileFills />} />
                <Route path="/settings" element={<Navigate to="/settings/risk" replace />} />
                <Route path="/settings/risk" element={<RiskSettings />} />
                <Route path="/settings/execution" element={<ExecutionSettings />} />
                <Route path="/settings/profiles/:profileId" element={<ProfileSettings />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/status" element={<Status />} />
                <Route path="/debug" element={<Debug />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </SSEProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}

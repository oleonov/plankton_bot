import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SSEProvider } from "./api/sse.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { Layout } from "./components/Layout.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Positions } from "./pages/Positions.tsx";
import { OrdersFills } from "./pages/OrdersFills.tsx";
import { Families } from "./pages/Families.tsx";
import { RiskQuarantine } from "./pages/RiskQuarantine.tsx";
import { Discovery } from "./pages/Discovery.tsx";
import { ControlCenter } from "./pages/ControlCenter.tsx";
import { Profiles } from "./pages/Profiles.tsx";
import { ProfileDetail } from "./pages/ProfileDetail.tsx";
import { ProfileOrders } from "./pages/ProfileOrders.tsx";
import { ProfilePositions } from "./pages/ProfilePositions.tsx";
import { ProfileFills } from "./pages/ProfileFills.tsx";
import { RiskSettings } from "./pages/RiskSettings.tsx";
import { ProfileSettings } from "./pages/ProfileSettings.tsx";
import { Audit } from "./pages/Audit.tsx";

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
                <Route path="/" element={<Navigate to="/control" replace />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/positions" element={<Positions />} />
                <Route path="/orders" element={<OrdersFills />} />
                <Route path="/families" element={<Families />} />
                <Route path="/risk" element={<RiskQuarantine />} />
                <Route path="/discovery" element={<Discovery />} />
                <Route path="/control" element={<ControlCenter />} />
                <Route path="/profiles" element={<Profiles />} />
                <Route path="/profiles/:profileId" element={<ProfileDetail />} />
                <Route path="/profiles/:profileId/orders" element={<ProfileOrders />} />
                <Route path="/profiles/:profileId/positions" element={<ProfilePositions />} />
                <Route path="/profiles/:profileId/fills" element={<ProfileFills />} />
                <Route path="/settings" element={<Navigate to="/settings/risk" replace />} />
                <Route path="/settings/risk" element={<RiskSettings />} />
                <Route path="/settings/profiles/:profileId" element={<ProfileSettings />} />
                <Route path="/audit" element={<Audit />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </SSEProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}

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
                <Route path="/families" element={<Families />} />
                <Route path="/risk" element={<RiskQuarantine />} />
                <Route path="/discovery" element={<Discovery />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </SSEProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}

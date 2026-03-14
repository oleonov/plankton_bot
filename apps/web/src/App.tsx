import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<div>Overview placeholder</div>} />
          <Route path="/positions" element={<div>Positions placeholder</div>} />
          <Route path="/orders" element={<div>Orders placeholder</div>} />
          <Route path="/families" element={<div>Families placeholder</div>} />
          <Route path="/risk" element={<div>Risk placeholder</div>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

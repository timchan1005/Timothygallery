import { useEffect, useState } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient, getAuthToken, subscribeAuthToken } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Gallery from "@/pages/gallery";
import Login from "@/pages/login";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Gallery} />
      <Route path="/folder/:id" component={Gallery} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthGate() {
  const [token, setToken] = useState<string | null>(getAuthToken());
  useEffect(() => subscribeAuthToken(setToken), []);
  if (!token) return <Login />;
  return (
    <Router hook={useHashLocation}>
      <AppRouter />
    </Router>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthGate />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

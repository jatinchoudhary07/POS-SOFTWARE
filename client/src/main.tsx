import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FullScreenLoading, LoginView } from './components/LoginView';
import { ReceiptPrinterProvider } from './components/ReceiptPrinter';
import { SplashScreen } from './components/SplashScreen';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider, useAuth } from './state/Auth';
import { LiveOrdersProvider } from './state/LiveOrders';
import './index.css';

/**
 * Nothing but the login screen renders until the server confirms a session. The live order
 * connection (Socket.IO) only starts after sign-in and is torn down on sign-out (key = user).
 */
function Gate() {
  const { state, expire } = useAuth();
  if (state.status === 'loading') return <FullScreenLoading />;
  if (state.status === 'signed-out') return <LoginView reason={state.reason} />;
  return (
    <LiveOrdersProvider key={state.user.id} role={state.user.role} onUnauthenticated={expire}>
      <ReceiptPrinterProvider>
        <App />
      </ReceiptPrinterProvider>
    </LiveOrdersProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SplashScreen />
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);

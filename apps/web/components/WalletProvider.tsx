'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Status = 'idle' | 'connecting' | 'connected';

interface WalletState {
  identityKey: string | null;
  network: 'mainnet' | 'testnet' | null;
  balance: number | null;
  status: Status;
  error: string | null;
  /** Connect once — shared across the whole app. Returns the identity pubkey. */
  connect: () => Promise<string | null>;
  /** Explicit disconnect (only on user action). Clears app-side state. */
  disconnect: () => void;
  /** Refresh the balance (e.g. after a tx). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);
const SS_KEY = 'launchpad.identityKey';

/**
 * One wallet connection for the entire app. Lives in the root layout, so the
 * identity persists across page navigations (the provider never remounts) and,
 * via sessionStorage, across reloads. Components read `identityKey` to render as
 * connected and sign through the shared `getWalletClient()` singleton — the user
 * connects once and is never asked again until they explicitly disconnect.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [identityKey, setIdentityKey] = useState<string | null>(null);
  const [network, setNetwork] = useState<'mainnet' | 'testnet' | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const rehydrated = useRef(false);

  // Optimistic rehydrate across reloads; signing re-authenticates if stale.
  useEffect(() => {
    if (rehydrated.current) return;
    rehydrated.current = true;
    const saved = sessionStorage.getItem(SS_KEY);
    if (saved) {
      setIdentityKey(saved);
      setStatus('connected');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { getBalanceSats } = await import('@launchpad/bsv/wallet');
      setBalance(await getBalanceSats());
    } catch {
      /* balance is best-effort */
    }
  }, []);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    try {
      const { connectWallet, walletError } = await import('@launchpad/bsv/wallet');
      try {
        const identity = await connectWallet();
        setIdentityKey(identity.identityPubkey);
        setNetwork(identity.network);
        setStatus('connected');
        sessionStorage.setItem(SS_KEY, identity.identityPubkey);
        void refresh();
        return identity.identityPubkey;
      } catch (e) {
        setError(walletError(e));
        setStatus('idle');
        return null;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
      return null;
    }
  }, [refresh]);

  const disconnect = useCallback(() => {
    setIdentityKey(null);
    setNetwork(null);
    setBalance(null);
    setStatus('idle');
    sessionStorage.removeItem(SS_KEY);
  }, []);

  return (
    <Ctx.Provider value={{ identityKey, network, balance, status, error, connect, disconnect, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWallet must be used within <WalletProvider>');
  return c;
}

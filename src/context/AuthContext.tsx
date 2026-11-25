import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { ensureUserWorkspaceSeeded } from '../utils/seedWorkspace';

interface AuthContextValue {
  user: User | null;
  authReady: boolean;
  seeding: boolean;
  authError: string | null;
  googleAccessToken: string | null;
  signInWithGoogle: () => Promise<void>;
  clearGoogleAccessToken: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// In-memory only OAuth access token cache (never persisted to localStorage/sessionStorage)
let cachedAccessToken: string | null = null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(cachedAccessToken);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        if (cachedAccessToken) {
          setGoogleAccessToken(cachedAccessToken);
        }
        setSeeding(true);
        try {
          await ensureUserWorkspaceSeeded(nextUser);
        } catch (err) {
          setAuthError(err instanceof Error ? err.message : 'Unable to initialize workspace.');
        } finally {
          setSeeding(false);
        }
      } else {
        cachedAccessToken = null;
        setGoogleAccessToken(null);
      }
      setAuthReady(true);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken || null;
      cachedAccessToken = token;
      setGoogleAccessToken(token);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Authentication popup could not complete.',
      );
    }
  };

  const clearGoogleAccessToken = () => {
    cachedAccessToken = null;
    setGoogleAccessToken(null);
  };

  const logout = async () => {
    setAuthError(null);
    cachedAccessToken = null;
    setGoogleAccessToken(null);
    await signOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        authReady,
        seeding,
        authError,
        googleAccessToken,
        signInWithGoogle,
        clearGoogleAccessToken,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

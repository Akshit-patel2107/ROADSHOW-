import React, { useState } from 'react';
import { AlertCircle, ArrowRight, Eye, Lock, Mail, PlaySquare, Shield, User } from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';
import { DEMO_IMAGES } from '../data/demoDataset';

type AuthMode = 'login' | 'register' | 'reset';

function mapFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  const msg = err instanceof Error ? err.message : String(err);
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'Invalid email or password. Please verify your credentials and try again.';
  }
  if (code.includes('email-already-in-use')) {
    return 'An account with this email address already exists. Sign in or reset your password.';
  }
  if (code.includes('operation-not-allowed')) {
    return 'Email/Password sign-in is not yet enabled in the Firebase Console for this project. Use Google Sign-In below, or enable Email/Password under Firebase Console -> Authentication -> Sign-in method.';
  }
  if (code.includes('network-request-failed')) {
    return 'Network request failed. Check your internet connection and try again.';
  }
  if (code.includes('popup-closed-by-user')) {
    return 'Google sign-in popup was closed before completion.';
  }
  if (code.includes('too-many-requests')) {
    return 'Too many unsuccessful attempts. Wait briefly before retrying.';
  }
  return msg || 'Authentication failed. Please try again.';
}

export function AuthScreen() {
  const {
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    requestPasswordReset,
    enterDemoMode,
  } = useRoadshadow();

  const [mode, setMode] = useState<AuthMode>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    if (!email.trim()) {
      setError('Please enter your work or institutional email address.');
      return;
    }
    if (mode !== 'reset' && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (mode === 'register' && displayName.trim().length < 2) {
      setError('Please enter your full name (minimum 2 characters).');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'login') {
        await loginWithEmail(email.trim(), password);
      } else if (mode === 'register') {
        await registerWithEmail(displayName.trim(), email.trim(), password);
        setInfoMsg('Account registered. Please verify your email inbox before accessing private Firestore records.');
      } else {
        await requestPasswordReset(email.trim());
        setInfoMsg('Password reset instructions sent if an account exists for that email.');
      }
    } catch (err) {
      setError(mapFirebaseAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      setError(mapFirebaseAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#071426] text-[#F5F8FC] grid grid-cols-1 lg:grid-cols-12">
      {/* Left Institutional Intelligence Column */}
      <div className="lg:col-span-7 relative flex flex-col justify-between p-8 lg:p-14 border-b lg:border-b-0 lg:border-r border-[#233B56] bg-[#0D1F35]">
        <div>
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-lg bg-[#2585FF] flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" aria-hidden="true" />
            </span>
            <div>
              <span className="text-xl font-bold tracking-tight text-[#F5F8FC]">ROADSHADOW 2.0</span>
              <p className="text-xs text-[#A9B8CA]">
                AI Road Safety Intelligence &amp; Junction Improvement Platform
              </p>
            </div>
          </div>

          <div className="mt-10 max-w-xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-[#F5F8FC] leading-tight text-balance">
              See the Risk Before the Accident.
            </h1>
            <p className="mt-4 text-base text-[#A9B8CA] leading-relaxed">
              Turning road near-misses into preventive safety intelligence for Indian urban intersections, school zones, highway merges, and municipal transport studies.
            </p>
          </div>

          <div className="mt-8 rounded-lg overflow-hidden border border-[#233B56] bg-[#071426]">
            <div className="relative aspect-[16/9]">
              <img
                src={DEMO_IMAGES.intersection}
                alt="Elevated urban traffic monitoring camera view of an Indian intersection"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#071426] via-[#071426]/70 to-transparent p-4">
                <p className="text-xs text-[#F5F8FC] font-medium">
                  Near-Miss Trajectory Analysis · Conflict Fingerprinting · Junction Improvement Lab
                </p>
                <p className="text-[11px] text-[#A9B8CA] mt-0.5">
                  TEAM ADIT — Akshit Patel &amp; Shah Darshil · National Innovation Competition
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#233B56] grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-[#A9B8CA]">
          <div>
            <p className="text-[#F5F8FC] font-medium">Evidence-First Scoring</p>
            <p className="mt-1 leading-relaxed">
              Provisional 0–100 risk bands kept strictly separate from detection confidence and never framed as accident probability.
            </p>
          </div>
          <div>
            <p className="text-[#F5F8FC] font-medium">Human-in-the-Loop</p>
            <p className="mt-1 leading-relaxed">
              Every candidate near-miss preserves original AI classification alongside analyst verification and audit logs.
            </p>
          </div>
          <div>
            <p className="text-[#F5F8FC] font-medium">Role-Based Governance</p>
            <p className="mt-1 leading-relaxed">
              Cloud Firestore security rules isolate PII and enforce Administrator, Analyst, and Viewer access boundaries.
            </p>
          </div>
        </div>
      </div>

      {/* Right Authentication & Demonstration Entry Column */}
      <div className="lg:col-span-5 flex items-center justify-center p-6 sm:p-10 lg:p-14">
        <div className="w-full max-w-md space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-[#F5F8FC]">
              {mode === 'login'
                ? 'Sign in to ROADSHADOW'
                : mode === 'register'
                  ? 'Create Analyst Account'
                  : 'Reset Account Password'}
            </h2>
            <p className="text-sm text-[#A9B8CA] mt-1">
              {mode === 'login'
                ? 'Access your Cloud Firestore safety workspace or explore the Anand pilot demonstration.'
                : mode === 'register'
                  ? 'Register with email and password for verified municipal workspace access.'
                  : 'Enter your registered email to receive Firebase password reset instructions.'}
            </p>
          </div>

          {error && (
            <div role="alert" className="p-3.5 rounded-md bg-[#E5484D]/10 border border-[#E5484D]/40 flex items-start gap-2.5 text-sm text-[#F5F8FC]">
              <AlertCircle className="w-4 h-4 text-[#E5484D] mt-0.5 shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {infoMsg && (
            <div role="status" className="p-3.5 rounded-md bg-[#2585FF]/10 border border-[#2585FF]/40 text-sm text-[#F5F8FC]">
              {infoMsg}
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 bg-[#2585FF] hover:bg-[#1C74E8] disabled:opacity-60 text-white text-sm font-medium rounded-md transition-colors"
          >
            <span>Continue with Google Sign-In</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t border-[#233B56]" />
            <span className="px-3 text-xs text-[#A9B8CA]">or with email credentials</span>
            <div className="flex-grow border-t border-[#233B56]" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label htmlFor="auth-name" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                  Full Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Dr. Aarav Mehta"
                    className="w-full bg-[#122943] border border-[#233B56] rounded-md pl-9 pr-3 py-2 text-sm text-[#F5F8FC] placeholder:text-[#A9B8CA]/60 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="analyst@municipality.gov.in"
                  className="w-full bg-[#122943] border border-[#233B56] rounded-md pl-9 pr-3 py-2 text-sm text-[#F5F8FC] placeholder:text-[#A9B8CA]/60 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                />
              </div>
            </div>

            {mode !== 'reset' && (
              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-[#A9B8CA] mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#A9B8CA] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full bg-[#122943] border border-[#233B56] rounded-md pl-9 pr-3 py-2 text-sm text-[#F5F8FC] placeholder:text-[#A9B8CA]/60 focus:outline-none focus:ring-2 focus:ring-[#2585FF]"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full px-4 py-2.5 bg-[#122943] hover:bg-[#1A3758] border border-[#233B56] disabled:opacity-60 text-[#F5F8FC] text-sm font-medium rounded-md transition-colors"
            >
              {busy
                ? 'Processing...'
                : mode === 'login'
                  ? 'Sign In with Email'
                  : mode === 'register'
                    ? 'Register Account'
                    : 'Send Password Reset Email'}
            </button>
          </form>

          <div className="flex items-center justify-between text-xs text-[#A9B8CA]">
            {mode !== 'login' ? (
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setInfoMsg(null);
                }}
                className="text-[#45B5FF] hover:underline"
              >
                Back to Sign In
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                  setInfoMsg(null);
                }}
                className="text-[#45B5FF] hover:underline"
              >
                Create an account
              </button>
            )}

            {mode !== 'reset' && (
              <button
                type="button"
                onClick={() => {
                  setMode('reset');
                  setError(null);
                  setInfoMsg(null);
                }}
                className="hover:text-[#F5F8FC] hover:underline"
              >
                Forgot password?
              </button>
            )}
          </div>

          <div className="pt-5 border-t border-[#233B56]">
            <div className="p-4 rounded-lg bg-[#122943] border border-[#233B56] space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F8FC]">
                <PlaySquare className="w-4 h-4 text-[#45B5FF]" />
                <span>Evaluate with Demonstration Mode</span>
              </div>
              <p className="text-xs text-[#A9B8CA] leading-relaxed">
                Explore the complete ROADSHADOW platform using the clearly labelled Anand Road Safety Pilot sample dataset without connecting a private account first.
              </p>
              <button
                type="button"
                onClick={() => enterDemoMode('ADMINISTRATOR')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#0D1F35] hover:bg-[#173252] border border-[#2585FF]/50 text-[#45B5FF] text-sm font-medium rounded-md transition-colors"
              >
                <Eye className="w-4 h-4" />
                <span>Launch Demonstration Mode</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

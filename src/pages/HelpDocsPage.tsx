import {
  AlertTriangle,
  BookOpen,
  Cpu,
  KeyRound,
  Scale,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useRoadshadow } from '../context/RoadshadowContext';

export function HelpDocsPage() {
  const { serverHealth, settings } = useRoadshadow();

  return (
    <div className="space-y-6">
      <div className="border-b border-[#233B56] pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-[#F5F8FC]">
          Help &amp; Methodology Documentation
        </h1>
        <p className="text-sm text-[#A9B8CA] mt-1 max-w-3xl">
          Scientific methodology, provisional risk scoring transparency, computer vision worker deployment, and authentication configuration for ROADSHADOW.
        </p>
      </div>

      {/* Scientific Boundaries & Non-Probability Disclaimer */}
      <section className="bg-[#122943] border border-[#EAB308]/40 rounded-lg p-5 space-y-3">
        <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-[#EAB308]" aria-hidden="true" />
          Scientific Boundaries &amp; Risk Score Disclaimer
        </h2>
        <p className="text-sm text-[#A9B8CA] leading-relaxed">
          ROADSHADOW identifies and prioritizes <strong className="text-[#F5F8FC]">potential near-miss conflicts</strong> observed in traffic video footage. It does <strong className="text-[#F5F8FC]">not</strong> claim to predict accidents with certainty, and the provisional 0–100 Risk Score is <strong className="text-[#F5F8FC]">not a statistical probability of an accident</strong>.
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-[#A9B8CA]">
          <li>
            <strong className="text-[#F5F8FC]">Separation of Metrics:</strong> Detection Confidence (0–100%) reflects object detector certainty in identifying road users, whereas the Provisional Risk Score (0–100) reflects proximity, closing velocity, time-to-collision (TTC), and vulnerable road user vulnerability.
          </li>
          <li>
            <strong className="text-[#F5F8FC]">Human-in-the-Loop Validation:</strong> Analysts review and confirm or reject flagged events. Original AI classifications are preserved immutably alongside human corrections for auditability.
          </li>
          <li>
            <strong className="text-[#F5F8FC]">Uncalibrated Camera Warnings:</strong> Monocular CCTV footage without homography calibration yields pixel-domain proximity estimates; such events are explicitly tagged as uncalibrated and carry measurement limitations.
          </li>
        </ul>
      </section>

      {/* Provisional Risk Scoring Formula */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-4">
        <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
          <Scale className="w-5 h-5 text-[#45B5FF]" aria-hidden="true" />
          Provisional Risk Scoring Model (RS-PROVISIONAL-1.0)
        </h2>
        <p className="text-sm text-[#A9B8CA] leading-relaxed">
          All numerical scores are calculated deterministically from structured trajectory measurements—never fabricated by a generative text model. Missing metrics (such as absent depth calibration) lower the effective weight and append a measurement limitation note rather than inventing numbers.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            {
              title: 'Estimated TTC',
              weight: '34% weight',
              detail: 'Shorter time-to-collision (<=1.0s = 95 pts) produces highest urgency; reweighted cleanly when unavailable.',
            },
            {
              title: 'Minimum Separation',
              weight: '24% weight',
              detail: 'Minimum inter-object clearance in image-plane pixels or calibrated space during peak convergence.',
            },
            {
              title: 'Relative Velocity',
              weight: '16% weight',
              detail: 'Higher closing speed between road users increases severity prior to any evasive maneuver.',
            },
            {
              title: 'Convergence Angle',
              weight: '14% weight',
              detail: 'Crossing (55°–135°) and opposing (>135°) vectors score higher than near-parallel movement.',
            },
            {
              title: 'VRU & Modifiers',
              weight: '12% + mods',
              detail: 'Pedestrians/two-wheelers vs motorized traffic plus +8 pts abrupt braking and +12 pts wrong-direction movement.',
            },
          ].map((factor) => (
            <div
              key={factor.title}
              className="p-3.5 rounded-md bg-[#0D1F35] border border-[#233B56]"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[#F5F8FC]">{factor.title}</h3>
                <span className="text-xs font-mono text-[#45B5FF]">{factor.weight}</span>
              </div>
              <p className="text-xs text-[#A9B8CA] mt-1.5 leading-relaxed">{factor.detail}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <div className="p-3 rounded bg-[#071426] border border-[#22C55E]/30">
            <p className="text-xs font-semibold text-[#22C55E]">Low Risk</p>
            <p className="text-sm font-mono tabular-nums text-[#F5F8FC] mt-0.5">
              0 – {settings.riskBands.lowMax}
            </p>
          </div>
          <div className="p-3 rounded bg-[#071426] border border-[#EAB308]/30">
            <p className="text-xs font-semibold text-[#EAB308]">Medium Risk</p>
            <p className="text-sm font-mono tabular-nums text-[#F5F8FC] mt-0.5">
              {settings.riskBands.lowMax + 1} – {settings.riskBands.mediumMax}
            </p>
          </div>
          <div className="p-3 rounded bg-[#071426] border border-[#F97316]/30">
            <p className="text-xs font-semibold text-[#F97316]">High Risk</p>
            <p className="text-sm font-mono tabular-nums text-[#F5F8FC] mt-0.5">
              {settings.riskBands.mediumMax + 1} – {settings.riskBands.highMax}
            </p>
          </div>
          <div className="p-3 rounded bg-[#071426] border border-[#E5484D]/30">
            <p className="text-xs font-semibold text-[#E5484D]">Critical Risk</p>
            <p className="text-sm font-mono tabular-nums text-[#F5F8FC] mt-0.5">
              {settings.riskBands.highMax + 1} – 100
            </p>
          </div>
        </div>
      </section>

      {/* Conflict Fingerprinting Rules */}
      <section className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
        <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-[#45B5FF]" aria-hidden="true" />
          Conflict Fingerprinting Criteria
        </h2>
        <p className="text-sm text-[#A9B8CA] leading-relaxed">
          Conflict Fingerprints aggregate recurring near-miss interactions sharing the same location, conflict type, road-user combination, movement corridor, and time-of-day window.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-sm text-[#A9B8CA]">
          <li>Events marked as <strong className="text-[#F5F8FC]">False positive</strong> are excluded from fingerprint calculations.</li>
          <li>A minimum of <strong className="text-[#F5F8FC]">2 matching observations</strong> is required to form a fingerprint.</li>
          <li>Patterns with <strong className="text-[#F5F8FC]">2–3 observations</strong> are labelled <strong className="text-[#EAB308]">Preliminary</strong>; patterns with <strong className="text-[#F5F8FC]">4 or more observations</strong> are promoted to <strong className="text-[#45B5FF]">Established</strong>.</li>
        </ul>
      </section>

      {/* External Computer Vision Worker & Environment Setup */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[#45B5FF]" aria-hidden="true" />
            Python FastAPI CV Worker Deployment
          </h2>
          <p className="text-sm text-[#A9B8CA] leading-relaxed">
            Current backend CV adapter mode:{' '}
            <span className="font-mono text-[#F5F8FC]">{serverHealth.cvAdapter.mode}</span>.
            To connect a dedicated GPU or CPU YOLO + ByteTrack worker for real-time frame decoding and multi-object tracking:
          </p>
          <ol className="list-decimal pl-5 space-y-1.5 text-xs text-[#A9B8CA] leading-relaxed">
            <li>Deploy the bundled FastAPI worker service (<code className="text-[#F5F8FC]">cv_worker/main.py</code>) with Python 3.10+ and its dependencies (<code className="text-[#F5F8FC]">cv_worker/requirements.txt</code>).</li>
            <li>Set <code className="text-[#F5F8FC]">CV_SERVICE_URL</code> (and optional <code className="text-[#F5F8FC]">CV_SERVICE_API_KEY</code>) in your server environment variables.</li>
            <li>Restart the ROADSHADOW server. Uploaded videos will automatically route to <code className="text-[#F5F8FC]">POST /analyze</code> and return structured per-frame detections and trajectories.</li>
          </ol>
        </div>

        <div className="bg-[#122943] border border-[#233B56] rounded-lg p-5 space-y-3">
          <h2 className="text-base font-semibold text-[#F5F8FC] flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-[#45B5FF]" aria-hidden="true" />
            Firebase Auth &amp; Gemini API Configuration
          </h2>
          <div className="space-y-2.5 text-xs text-[#A9B8CA] leading-relaxed">
            <div className="p-3 rounded bg-[#0D1F35] border border-[#233B56]">
              <p className="font-medium text-[#F5F8FC] flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-[#45B5FF]" aria-hidden="true" />
                Gemini Server-Side Integration
              </p>
              <p className="mt-1">
                Status: <span className="font-mono text-[#F5F8FC]">{serverHealth.geminiConfigured ? 'Configured' : 'API key required'}</span>. Configure <code className="text-[#F5F8FC]">GEMINI_API_KEY</code> in AI Studio Secrets so server-side explanation, recommendation, report summary, and natural-language query endpoints operate securely without exposing keys to the browser.
              </p>
            </div>
            <div className="p-3 rounded bg-[#0D1F35] border border-[#233B56]">
              <p className="font-medium text-[#F5F8FC] flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-[#22C55E]" aria-hidden="true" />
                Enabling Email/Password Sign-In
              </p>
              <p className="mt-1">
                Google Sign-In is ready immediately. To also accept Email/Password registrations, enable the Email/Password provider inside Firebase Console &rarr; Authentication &rarr; Sign-in method. New email accounts must verify their email before writing to Cloud Firestore.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

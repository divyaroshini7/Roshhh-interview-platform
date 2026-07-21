import React, { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Square, Volume2, ArrowRight, RotateCcw, Radio, Loader2, ChevronDown, ChevronUp, CheckCircle2, TrendingUp, Award } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid, Cell } from "recharts";

// ---------- Fonts ----------
function useFonts() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);
}

// ---------- Design tokens ----------
const T = {
  bg: "#14121A",
  panel: "#1D1A26",
  panelLine: "#2E2A3A",
  text: "#F3F1F7",
  muted: "#948FA3",
  onair: "#FF5F4C",
  ai: "#6C5CE7",
  success: "#3ECF8E",
  warn: "#FFB020",
};

// ---------- Offline-safe fallback content ----------
// Used whenever the live AI call fails, so the interview never gets stuck.
const QUESTION_BANK = {
  generic: [
    "Tell me a little about yourself and what makes you a strong fit for this role.",
    "Describe a time you faced a conflict on a team, and how you handled it.",
    "What's your biggest strength, and how have you used it to succeed?",
    "Tell me about a challenge you overcame recently.",
    "Where do you see yourself in five years?",
    "How do you handle pressure or tight deadlines?",
    "Describe a time you made a mistake at work — what did you learn from it?",
    "Why should we hire you over other candidates?",
  ],
  technical: [
    "Walk me through how you'd approach designing a system for {role}.",
    "Tell me about a technical challenge you've faced recently, and how you solved it.",
    "How do you approach debugging a tricky, hard-to-reproduce bug?",
    "Explain a concept from your field as if you were talking to someone non-technical.",
    "How do you decide between two different technical approaches to the same problem?",
    "Tell me about a project you're proud of, and the technical decisions behind it.",
    "How do you keep your skills up to date as a {role}?",
    "How would you go about optimizing a slow-performing piece of code or system?",
  ],
};

function fallbackQuestion(domain, role, index) {
  const bank = QUESTION_BANK[domain] || QUESTION_BANK.generic;
  const q = bank[index % bank.length];
  return q.replace("{role}", role || "this role");
}

function fallbackEvaluation(answerText) {
  const words = (answerText || "").trim().split(/\s+/).filter(Boolean).length;
  const score = words === 0 ? 2 : Math.max(3, Math.min(9, 3 + Math.floor(words / 12)));
  const feedback =
    words === 0
      ? "I didn't catch an answer there. Try speaking a bit louder and more directly into the mic."
      : score >= 7
      ? "That was a clear, well-developed answer with good structure."
      : score >= 5
      ? "That's a reasonable answer, though it could go a little deeper."
      : "That answer was quite brief. Try expanding with more detail next time.";
  const strength = words > 40 ? "You gave a thorough, detailed response." : "You kept your answer concise and to the point.";
  const improvement = "Try backing up your answer with one specific, concrete example.";
  return { score, feedback, strength, improvement };
}

function fallbackReport(log) {
  const scores = log.map((t) => t.evaluation.score);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 5;
  const overallScore = Math.round(avg);
  return {
    overallScore,
    summary: `Across ${log.length} questions, you averaged a score of ${overallScore} out of 10. Keep practicing answering out loud — the more you speak your answers, the more natural it becomes.`,
    categoryScores: {
      communication: overallScore,
      depth: Math.max(1, overallScore - 1),
      confidence: overallScore,
      clarity: Math.max(1, overallScore - 1),
    },
    topStrengths: ["You completed the full mock interview.", "You answered every question out loud.", "You're building real speaking practice."],
    keyImprovements: ["Add specific examples to your answers.", "Practice pacing so answers feel less rushed.", "Keep repeating sessions to build confidence."],
    recommendation: "Run another session focusing on one weak area at a time, and try to speak a little longer on each answer.",
  };
}

// ---------- API helper ----------
// This calls OUR OWN backend (see /api/interview.js), which holds the
// Anthropic API key securely and forwards the request. Never call
// api.anthropic.com directly from the browser in a real deployed app —
// that would expose your API key to anyone who opens dev tools.
async function callClaude(system, userText) {
  let response;
  try {
    response = await fetch("/api/interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, userText }),
    });
  } catch (networkErr) {
    console.error("Roshhh: network error calling AI", networkErr);
    throw new Error("network");
  }
  if (!response.ok) {
    console.error("Roshhh: AI call failed with status", response.status);
    throw new Error("status-" + response.status);
  }
  const data = await response.json();
  const raw = (data.content || []).map((b) => b.text || "").join("\n");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("Roshhh: failed to parse AI JSON response", raw);
    throw new Error("parse");
  }
}

// Wraps callClaude with one silent retry so a single transient network blip
// doesn't interrupt the conversation.
async function callClaudeReliable(system, userText) {
  try {
    return await callClaude(system, userText);
  } catch (e) {
    console.warn("Roshhh: first attempt failed, retrying once", e);
    await new Promise((r) => setTimeout(r, 900));
    return await callClaude(system, userText);
  }
}

// ---------- Waveform (real mic amplitude) ----------
function useWaveform(isListening) {
  const [levels, setLevels] = useState(new Array(28).fill(4));
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        src.connect(analyser);
        analyserRef.current = analyser;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(dataArray);
          const bars = 28;
          const step = Math.floor(dataArray.length / bars);
          const next = new Array(bars).fill(0).map((_, i) => {
            const v = dataArray[i * step] || 0;
            return Math.max(4, Math.min(48, (v / 255) * 48));
          });
          setLevels(next);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        // mic denied — fall back to gentle idle animation
        const tick = () => {
          setLevels((prev) => prev.map(() => 4 + Math.random() * 6));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }
    }
    function stop() {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
      setLevels(new Array(28).fill(4));
    }
    if (isListening) start();
    else stop();
    return () => stop();
  }, [isListening]);

  return levels;
}

// ---------- Speech recognition hook ----------
function useSpeechRecognition() {
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const finalRef = useRef("");

  useEffect(() => {
    if (!supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      let final = finalRef.current;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t + " ";
        else interim += t;
      }
      finalRef.current = final;
      setTranscript(final + interim);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
  }, [supported]);

  const start = useCallback(() => {
    finalRef.current = "";
    setTranscript("");
    setListening(true);
    try { recRef.current && recRef.current.start(); } catch (e) {}
  }, []);

  const stop = useCallback(() => {
    setListening(false);
    try { recRef.current && recRef.current.stop(); } catch (e) {}
  }, []);

  return { supported, listening, transcript, start, stop, setTranscript };
}

// ---------- TTS ----------
function speak(text, onDone) {
  if (!("speechSynthesis" in window)) { onDone && onDone(); return; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((v) => /en-US|en-GB/i.test(v.lang) && /female|samantha|google us english/i.test(v.name));
  if (preferred) utter.voice = preferred;
  utter.onend = () => onDone && onDone();
  utter.onerror = () => onDone && onDone();
  window.speechSynthesis.speak(utter);
}

// ---------- On Air light + waveform component ----------
function StudioMeter({ active, levels }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 14px", borderRadius: 999,
          border: `1px solid ${active ? T.onair : T.panelLine}`,
          background: active ? "rgba(255,95,76,0.12)" : "transparent",
          transition: "all 0.3s",
        }}
      >
        <div style={{
          width: 8, height: 8, borderRadius: 999,
          background: active ? T.onair : T.muted,
          boxShadow: active ? `0 0 12px ${T.onair}` : "none",
          animation: active ? "pulse 1.2s ease-in-out infinite" : "none",
        }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 1.5, color: active ? T.onair : T.muted }}>
          {active ? "ON AIR" : "STANDBY"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 48 }}>
        {levels.map((h, i) => (
          <div key={i} style={{
            width: 3, height: h, borderRadius: 2,
            background: active ? `linear-gradient(to top, ${T.onair}, ${T.ai})` : T.panelLine,
            transition: "height 0.08s ease",
          }} />
        ))}
      </div>
    </div>
  );
}

// ---------- Setup Screen ----------
function SetupScreen({ onStart }) {
  const [domain, setDomain] = useState("generic");
  const [role, setRole] = useState("");
  const [numQuestions, setNumQuestions] = useState(5);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Radio size={20} color={T.onair} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 2, color: T.muted, textTransform: "uppercase" }}>
          Roshhh Interview Studio
        </span>
      </div>
      <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 42, fontWeight: 700, color: T.text, margin: "0 0 12px", lineHeight: 1.1 }}>
        Practice interviews<br />out loud.
      </h1>
      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, color: T.muted, marginBottom: 40, lineHeight: 1.6 }}>
        A fully spoken mock interview. Roshhh asks out loud, you answer out loud, and it coaches you out loud — built to help you speak up boldly and professionally in front of an HR panel, without hesitation.
      </p>

      <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 28 }}>
        <label style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: T.text, display: "block", marginBottom: 10 }}>
          Interview type
        </label>
        <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
          {[
            { id: "generic", label: "Generic / HR" },
            { id: "technical", label: "Technical" },
          ].map((opt) => (
            <button
              key={opt.id}
              onClick={() => setDomain(opt.id)}
              style={{
                flex: 1, padding: "12px 16px", borderRadius: 10,
                border: `1px solid ${domain === opt.id ? T.ai : T.panelLine}`,
                background: domain === opt.id ? "rgba(108,92,231,0.15)" : "transparent",
                color: domain === opt.id ? T.text : T.muted,
                fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 500,
                cursor: "pointer", transition: "all 0.2s",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <label style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: T.text, display: "block", marginBottom: 10 }}>
          Target role or topic
        </label>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder={domain === "technical" ? "e.g. Backend Engineer — Python, REST APIs" : "e.g. Marketing Coordinator"}
          style={{
            width: "100%", padding: "12px 14px", borderRadius: 10,
            border: `1px solid ${T.panelLine}`, background: "#0F0D15", color: T.text,
            fontFamily: "'Inter', sans-serif", fontSize: 14, marginBottom: 24, outline: "none", boxSizing: "border-box",
          }}
        />

        <label style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600, color: T.text, display: "block", marginBottom: 10 }}>
          Number of questions: <span style={{ color: T.ai, fontFamily: "'JetBrains Mono', monospace" }}>{numQuestions}</span>
        </label>
        <input
          type="range" min={3} max={8} value={numQuestions}
          onChange={(e) => setNumQuestions(Number(e.target.value))}
          style={{ width: "100%", marginBottom: 28, accentColor: T.ai }}
        />

        <button
          onClick={async () => {
            try {
              const s = await navigator.mediaDevices.getUserMedia({ audio: true });
              s.getTracks().forEach((t) => t.stop());
            } catch (e) {
              console.warn("Roshhh: mic permission not granted yet", e);
            }
            onStart({ domain, role: role.trim() || (domain === "technical" ? "Software Engineer" : "General role"), numQuestions });
          }}
          style={{
            width: "100%", padding: "14px 20px", borderRadius: 10, border: "none",
            background: `linear-gradient(90deg, ${T.onair}, ${T.ai})`,
            color: "#fff", fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 600,
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          Start interview <ArrowRight size={17} />
        </button>
      </div>
    </div>
  );
}

// ---------- Interview Screen ----------
function InterviewScreen({ config, onFinish }) {
  const [phase, setPhase] = useState("loading-question"); // loading-question | asking | listening | evaluating | feedback | mic-error
  const [question, setQuestion] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [qIndex, setQIndex] = useState(0);
  const [transcriptLog, setTranscriptLog] = useState([]);
  const [error, setError] = useState(null);
  const { supported, listening, transcript, start, stop } = useSpeechRecognition();
  const levels = useWaveform(listening);
  const lastAnswerRef = useRef("");

  const buildContext = () =>
    transcriptLog.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}\nScore: ${t.evaluation.score}/10`).join("\n\n");

  const beginAnswer = useCallback(() => {
    try {
      start();
      setPhase("listening");
    } catch (e) {
      console.error("Roshhh: mic failed to start", e);
      setPhase("mic-error");
    }
  }, [start]);

  const loadFirstQuestion = useCallback(async () => {
    setError(null);
    setPhase("loading-question");
    let q;
    try {
      const res = await callClaudeReliable(
        `You are Roshhh, an AI interviewer conducting a spoken mock interview out loud, the way a real HR interviewer would. Domain: ${config.domain}. Target role/topic: "${config.role}". Respond ONLY with valid JSON, no markdown, no code fences. JSON shape: {"question": string}. The question should be natural and spoken-friendly (1-3 sentences), suited to an opening interview question for this domain and role. If domain is technical, ask a real, concrete technical or problem-solving question relevant to the role. If generic, ask a behavioral/HR-style question.`,
        "Generate the opening interview question."
      );
      q = res.question;
    } catch (e) {
      console.warn("Roshhh: AI question generation failed, using fallback bank", e);
      q = fallbackQuestion(config.domain, config.role, 0);
    }
    setQuestion(q);
    setPhase("asking");
    speak(q, () => beginAnswer());
  }, [beginAnswer, config.domain, config.role]);

  useEffect(() => { loadFirstQuestion(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitAnswer = async (answerText) => {
    stop();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setPhase("evaluating");
    const isLast = qIndex >= config.numQuestions - 1;
    let evalObj, nextQ;
    try {
      const res = await callClaudeReliable(
        `You are Roshhh, an AI interviewer speaking with a candidate out loud, the way a real HR interviewer would give live verbal feedback. Domain: ${config.domain}. Target role/topic: "${config.role}". This is question ${qIndex + 1} of ${config.numQuestions}.
Previous exchanges:
${buildContext() || "(none yet)"}

Current question: "${question}"
Candidate's spoken answer (transcribed): "${answerText}"

Respond ONLY with valid JSON, no markdown, no code fences. JSON shape:
{"score": number (1-10), "feedback": string (2-3 sentences, warm but direct coaching tone, written to be spoken aloud naturally), "strength": string (one short spoken-friendly sentence), "improvement": string (one short spoken-friendly sentence)${isLast ? "" : `, "nextQuestion": string (natural, spoken-friendly, 1-3 sentences, a new question that follows logically, matching the domain)`}}`,
        "Evaluate the answer and continue the interview."
      );
      evalObj = { score: res.score, feedback: res.feedback, strength: res.strength, improvement: res.improvement };
      nextQ = res.nextQuestion;
    } catch (e) {
      console.warn("Roshhh: AI evaluation failed, using local fallback scoring", e);
      evalObj = fallbackEvaluation(answerText);
      nextQ = fallbackQuestion(config.domain, config.role, qIndex + 1);
    }
    const newLog = [...transcriptLog, { question, answer: answerText, evaluation: evalObj }];
    setTranscriptLog(newLog);
    setFeedback(evalObj);
    setPhase("feedback");
    if (!isLast) {
      window.__roshhh_next_q = nextQ;
    } else {
      window.__roshhh_final = newLog;
    }
  };

  const handleContinue = useCallback(() => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const isLast = qIndex >= config.numQuestions - 1;
    if (isLast) {
      onFinish(window.__roshhh_final || transcriptLog, config);
      return;
    }
    const next = window.__roshhh_next_q;
    setQIndex((i) => i + 1);
    setQuestion(next);
    setFeedback(null);
    setPhase("asking");
    speak(next, () => beginAnswer());
  }, [qIndex, config, transcriptLog, onFinish, beginAnswer]);

  // The AI speaks its feedback aloud, then automatically moves on —
  // a real interviewer doesn't wait for you to click a button either.
  useEffect(() => {
    if (phase === "feedback" && feedback) {
      const spoken = `${feedback.feedback} ${feedback.strength} ${feedback.improvement}`;
      speak(spoken, () => handleContinue());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, feedback]);

  if (error) {
    return (
      <div style={{ maxWidth: 560, margin: "80px auto", textAlign: "center", padding: 24 }}>
        <p style={{ fontFamily: "'Inter', sans-serif", color: T.onair, fontSize: 15, marginBottom: 16 }}>{error}</p>
        <button
          onClick={() => {
            if (phase === "loading-question") loadFirstQuestion();
            else if (lastAnswerRef.current) { setError(null); submitAnswer(lastAnswerRef.current); }
            else { setError(null); setPhase("asking"); }
          }}
          style={btnPrimary}
        >
          <RotateCcw size={15} /> Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Radio size={18} color={T.onair} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 1.5, color: T.muted }}>
            QUESTION {qIndex + 1} / {config.numQuestions}
          </span>
        </div>
        <StudioMeter active={phase === "listening"} levels={levels} />
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 32, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ width: 26, height: 26, borderRadius: 999, background: T.ai, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Volume2 size={14} color="#fff" />
          </div>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: T.muted, fontWeight: 500 }}>HR Panel — Roshhh</span>
        </div>
        {phase === "loading-question" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: T.muted, fontFamily: "'Inter', sans-serif" }}>
            <Loader2 size={16} className="spin" /> Preparing your first question…
          </div>
        ) : (
          <>
            <p style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, color: T.text, lineHeight: 1.5, margin: 0 }}>{question}</p>
            {phase === "asking" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, color: T.ai, fontFamily: "'Inter', sans-serif", fontSize: 12 }}>
                <Volume2 size={13} /> Speaking — get ready to answer
              </div>
            )}
          </>
        )}
      </div>

      {(phase === "asking" || phase === "listening") && supported && (
        <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 32 }}>
          <div style={{ minHeight: 60, fontFamily: "'Inter', sans-serif", fontSize: 15, color: transcript ? T.text : T.muted, lineHeight: 1.6, marginBottom: 20 }}>
            {phase === "listening"
              ? (transcript || "Listening — go ahead and speak your answer.")
              : "Getting ready to listen…"}
          </div>
          {phase === "listening" && (
            <button onClick={() => submitAnswer(transcript)} style={btnStop}>
              <Square size={14} /> Done — submit answer
            </button>
          )}
        </div>
      )}

      {(phase === "asking" || phase === "listening") && !supported && (
        <div style={{ background: T.panel, border: `1px solid ${T.onair}`, borderRadius: 16, padding: 28 }}>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: T.warn, margin: 0, lineHeight: 1.6 }}>
            This browser doesn't support voice input, and Roshhh is built for speaking practice only. Please open this in Chrome on desktop or Android to continue.
          </p>
        </div>
      )}

      {phase === "mic-error" && (
        <div style={{ background: T.panel, border: `1px solid ${T.onair}`, borderRadius: 16, padding: 28 }}>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: T.warn, marginBottom: 16, lineHeight: 1.6 }}>
            Couldn't access your microphone. Check that mic permission is allowed for this site, then try again.
          </p>
          <button onClick={beginAnswer} style={btnPrimary}>
            <Mic size={16} /> Try again
          </button>
        </div>
      )}

      {phase === "evaluating" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: T.muted, fontFamily: "'Inter', sans-serif", padding: 24 }}>
          <Loader2 size={16} className="spin" /> Analyzing your answer…
        </div>
      )}

      {phase === "feedback" && feedback && (
        <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
            <div style={{
              width: 52, height: 52, borderRadius: 12, background: scoreColor(feedback.score, 0.15),
              display: "flex", alignItems: "center", justifyContent: "center",
              border: `1px solid ${scoreColor(feedback.score, 1)}`,
            }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: scoreColor(feedback.score, 1) }}>{feedback.score}</span>
            </div>
            <div>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: T.muted }}>Score out of 10</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, color: T.text, fontWeight: 600 }}>Question {qIndex + 1} feedback</div>
            </div>
          </div>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: T.text, lineHeight: 1.6, marginBottom: 16 }}>{feedback.feedback}</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 22 }}>
            <div style={{ padding: 14, borderRadius: 10, background: "rgba(62,207,142,0.08)", border: `1px solid rgba(62,207,142,0.3)` }}>
              <div style={{ fontSize: 11, color: T.success, fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>STRENGTH</div>
              <div style={{ fontSize: 13, color: T.text, fontFamily: "'Inter', sans-serif" }}>{feedback.strength}</div>
            </div>
            <div style={{ padding: 14, borderRadius: 10, background: "rgba(255,176,32,0.08)", border: `1px solid rgba(255,176,32,0.3)` }}>
              <div style={{ fontSize: 11, color: T.warn, fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>IMPROVE</div>
              <div style={{ fontSize: 13, color: T.text, fontFamily: "'Inter', sans-serif" }}>{feedback.improvement}</div>
            </div>
          </div>
          <button onClick={handleContinue} style={{ ...btnStop, borderColor: T.panelLine, color: T.muted, background: "transparent" }}>
            Skip ahead <ArrowRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function scoreColor(score, alpha) {
  const c = score >= 7 ? [62, 207, 142] : score >= 4 ? [255, 176, 32] : [255, 95, 76];
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

const btnPrimary = {
  padding: "12px 22px", borderRadius: 10, border: "none",
  background: `linear-gradient(90deg, ${T.onair}, ${T.ai})`, color: "#fff",
  fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 600,
  cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
};
const btnStop = {
  padding: "12px 22px", borderRadius: 10, border: `1px solid ${T.onair}`,
  background: "rgba(255,95,76,0.12)", color: T.onair,
  fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 600,
  cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
};

// ---------- Report Screen ----------
function ReportScreen({ log, config, onRestart }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const transcript = log.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}\nScore: ${t.evaluation.score}/10 — ${t.evaluation.feedback}`).join("\n\n");
        const res = await callClaudeReliable(
          `You are an AI interview coach producing a final report. Domain: ${config.domain}. Role/topic: "${config.role}".
Full transcript:
${transcript}

Respond ONLY with valid JSON, no markdown, no code fences. JSON shape:
{"overallScore": number (1-10), "summary": string (3-4 sentences, direct coaching tone), "categoryScores": {"communication": number(1-10), "depth": number(1-10), "confidence": number(1-10), "clarity": number(1-10)}, "topStrengths": [string,string,string], "keyImprovements": [string,string,string], "recommendation": string (1-2 sentences on what to practice next)}`,
          "Generate the final interview report."
        );
        setReport(res);
      } catch (e) {
        console.warn("Roshhh: AI report generation failed, using local fallback report", e);
        setReport(fallbackReport(log));
      }
    })();
  }, []);

  const chartData = report ? [
    { name: "Comm.", value: report.categoryScores.communication },
    { name: "Depth", value: report.categoryScores.depth },
    { name: "Confid.", value: report.categoryScores.confidence },
    { name: "Clarity", value: report.categoryScores.clarity },
  ] : [];

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <Award size={20} color={T.onair} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 2, color: T.muted, textTransform: "uppercase" }}>Session Report</span>
      </div>

      {!report && !error && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: T.muted, fontFamily: "'Inter', sans-serif", padding: 24 }}>
          <Loader2 size={16} className="spin" /> Compiling your report…
        </div>
      )}
      {error && <p style={{ color: T.warn, fontFamily: "'Inter', sans-serif", marginBottom: 24 }}>{error}</p>}

      {report && (
        <>
          <div style={{ display: "flex", gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
            <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 28, flex: "1 1 200px" }}>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: T.muted, marginBottom: 8 }}>Overall score</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 48, fontWeight: 700, color: scoreColor(report.overallScore, 1) }}>
                {report.overallScore}<span style={{ fontSize: 20, color: T.muted }}>/10</span>
              </div>
            </div>
            <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 20, flex: "2 1 320px" }}>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: T.muted, marginBottom: 8 }}>Category breakdown</div>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.panelLine} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: T.muted, fontSize: 11, fontFamily: "Inter" }} axisLine={{ stroke: T.panelLine }} tickLine={false} />
                  <YAxis domain={[0, 10]} tick={{ fill: T.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {chartData.map((d, i) => <Cell key={i} fill={scoreColor(d.value, 1)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: T.text, lineHeight: 1.7, margin: 0 }}>{report.summary}</p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                <CheckCircle2 size={15} color={T.success} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 1, color: T.success }}>TOP STRENGTHS</span>
              </div>
              {report.topStrengths.map((s, i) => (
                <div key={i} style={{ fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: T.text, marginBottom: 8, lineHeight: 1.5 }}>• {s}</div>
              ))}
            </div>
            <div style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 16, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                <TrendingUp size={15} color={T.warn} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 1, color: T.warn }}>KEY IMPROVEMENTS</span>
              </div>
              {report.keyImprovements.map((s, i) => (
                <div key={i} style={{ fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: T.text, marginBottom: 8, lineHeight: 1.5 }}>• {s}</div>
              ))}
            </div>
          </div>

          <div style={{ background: "rgba(108,92,231,0.1)", border: `1px solid ${T.ai}`, borderRadius: 16, padding: 20, marginBottom: 32 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 1, color: T.ai, marginBottom: 6 }}>NEXT STEP</div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: T.text, lineHeight: 1.6 }}>{report.recommendation}</div>
          </div>
        </>
      )}

      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: 1.5, color: T.muted, marginBottom: 14 }}>FULL TRANSCRIPT</div>
      {log.map((item, i) => (
        <div key={i} style={{ background: T.panel, border: `1px solid ${T.panelLine}`, borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
          <button
            onClick={() => setExpanded(expanded === i ? null : i)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", background: "transparent", border: "none", cursor: "pointer" }}
          >
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: T.text, textAlign: "left" }}>Q{i + 1}: {item.question.slice(0, 60)}{item.question.length > 60 ? "…" : ""}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: scoreColor(item.evaluation.score, 1) }}>{item.evaluation.score}/10</span>
              {expanded === i ? <ChevronUp size={16} color={T.muted} /> : <ChevronDown size={16} color={T.muted} />}
            </div>
          </button>
          {expanded === i && (
            <div style={{ padding: "0 18px 18px" }}>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: T.muted, marginBottom: 8 }}><strong style={{ color: T.text }}>Answer:</strong> {item.answer || "(no answer captured)"}</p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: T.muted }}><strong style={{ color: T.text }}>Coach:</strong> {item.evaluation.feedback}</p>
            </div>
          )}
        </div>
      ))}

      <button onClick={onRestart} style={{ ...btnPrimary, marginTop: 28 }}>
        <RotateCcw size={16} /> Start new interview
      </button>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  useFonts();
  const [screen, setScreen] = useState("setup");
  const [config, setConfig] = useState(null);
  const [finalLog, setFinalLog] = useState(null);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, backgroundImage: "radial-gradient(circle at 20% 0%, rgba(108,92,231,0.08), transparent 40%), radial-gradient(circle at 80% 100%, rgba(255,95,76,0.06), transparent 40%)" }}>
      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid ${T.ai}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .spin, * { animation: none !important; } }
      `}</style>
      {screen === "setup" && (
        <SetupScreen onStart={(cfg) => { setConfig(cfg); setScreen("interview"); }} />
      )}
      {screen === "interview" && config && (
        <InterviewScreen config={config} onFinish={(log) => { setFinalLog(log); setScreen("report"); }} />
      )}
      {screen === "report" && finalLog && (
        <ReportScreen log={finalLog} config={config} onRestart={() => { setScreen("setup"); setFinalLog(null); }} />
      )}
    </div>
  );
}

import React, { useState, useRef, useEffect } from "react";

const TTSPlayer = () => {
  const [text, setText] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStreamingMode, setIsStreamingMode] = useState(true);
  const audioCtxRef = useRef(null);
  const nextTimeRef = useRef(0);
  const pendingPCMRef = useRef([]);
  const pendingLenRef = useRef(0);
  const SAMPLE_RATE_DEFAULT = 44100;
  const TARGET_BATCH_SEC = 0.25;

  const [apiUrl, setApiUrl] = useState(() => {
    return localStorage.getItem('ttsApiUrl') || '';
  });

  const [language, setLanguage] = useState(() => {
    return localStorage.getItem('ttsLanguage') || 'en';
  });

  const [gender, setGender] = useState(() => {
    return localStorage.getItem('ttsGender') || 'female';
  });

  useEffect(() => {
    localStorage.setItem('ttsApiUrl', apiUrl);
    localStorage.setItem('ttsLanguage', language);
    localStorage.setItem('ttsGender', gender);
  }, [apiUrl, language, gender]);

  const clearSettings = () => {
    setApiUrl('');
    setLanguage('en');
    setGender('female');
    localStorage.removeItem('ttsApiUrl');
    localStorage.removeItem('ttsLanguage');
    localStorage.removeItem('ttsGender');
  };

  const stopAudio = () => {
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
    nextTimeRef.current = 0;
    pendingPCMRef.current = [];
    pendingLenRef.current = 0;
    setIsPlaying(false);
  };

  const playStreamingAudio = async (response) => {
    const reader = response.body.getReader();
    const headerSampleRate = Number(response.headers.get("X-Audio-Sample-Rate")) || SAMPLE_RATE_DEFAULT;

    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
      sampleRate: headerSampleRate,
    });

    const primingLead = Math.max(0.05, audioCtxRef.current.baseLatency || 0.05);
    nextTimeRef.current = audioCtxRef.current.currentTime + primingLead;

    let wavBytesToSkip = 44; // Default WAV header size

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      let start = value.byteOffset;
      let len = value.byteLength;

      // Skip header once
      if (wavBytesToSkip > 0) {
        const skip = Math.min(wavBytesToSkip, len);
        start += skip;
        len -= skip;
        wavBytesToSkip -= skip;
        if (len <= 0) continue;
      }

      const float32Chunk = convertPCM16ToFloat32(value.buffer, start, len);
      if (float32Chunk.length === 0) continue;

      const currentTime = audioCtxRef.current.currentTime;
      console.log(`Chunk received at ${formatTimestamp(currentTime)} - Length: ${float32Chunk.length} samples`);

      pendingPCMRef.current.push(float32Chunk);
      pendingLenRef.current += float32Chunk.length;

      const samplesPerBatch = Math.round(headerSampleRate * TARGET_BATCH_SEC);
      if (pendingLenRef.current >= samplesPerBatch) {
        flushBatch(audioCtxRef.current, headerSampleRate);
      }
    }

    // Flush any remaining tail audio
    flushBatch(audioCtxRef.current, headerSampleRate);
  };

  const playFullAudio = async (response) => {
    const reader = response.body.getReader();
    const chunks = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      totalLength += value.length;
    }

    const combined = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of chunks) {
      combined.set(chunk, pos);
      pos += chunk.length;
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    const float32Data = convertPCM16ToFloat32(combined.buffer, 44, combined.byteLength - 44);
    const buffer = audioCtx.createBuffer(1, float32Data.length, audioCtx.sampleRate);
    buffer.copyToChannel(float32Data, 0);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    
    console.log(`Playing full audio at ${formatTimestamp(audioCtx.currentTime)} - Duration: ${formatTimestamp(buffer.duration)}`);
    source.start();
    
    source.onended = () => {
      console.log(`Full audio finished at ${formatTimestamp(audioCtx.currentTime)}`);
      try {
        source.disconnect();
      } catch {}
    };
  };

  const flushBatch = (ctx, sampleRate) => {
    const total = pendingLenRef.current;
    if (!total) return;

    const out = new Float32Array(total);
    let pos = 0;
    for (const part of pendingPCMRef.current) {
      out.set(part, pos);
      pos += part.length;
    }

    pendingPCMRef.current = [];
    pendingLenRef.current = 0;

    const buf = ctx.createBuffer(1, out.length, sampleRate);
    buf.getChannelData(0).set(out);

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);

    const when = Math.max(nextTimeRef.current, ctx.currentTime + 0.005);
    console.log(`Playing chunk at ${formatTimestamp(when)} - Duration: ${formatTimestamp(buf.duration)}`);
    source.start(when);
    source.onended = () => {
      console.log(`Chunk finished at ${formatTimestamp(ctx.currentTime)}`);
      try {
        source.disconnect();
      } catch {}
    };

    nextTimeRef.current = when + buf.duration;
  };

  const formatTimestamp = (timeInSeconds) => {
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const milliseconds = Math.floor((timeInSeconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${milliseconds.toString().padStart(3, '0')}`;
  };

  const convertPCM16ToFloat32 = (buffer, byteOffset, byteLength) => {
    const alignedLength = byteLength & ~1;
    if (alignedLength <= 0) return new Float32Array(0);
    const dv = new DataView(buffer, byteOffset, alignedLength);
    const out = new Float32Array(alignedLength / 2);

    for (let i = 0; i < out.length; i++) {
      out[i] = dv.getInt16(i * 2, true) / 32768;
    }

    return out;
  };

  const playAudio = async () => {
    if (!text.trim()) {
      alert("Please enter some text");
      return;
    }

    stopAudio(); // cleanup
    setIsPlaying(true);

    try {
      
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language,
          gender,
        }),
      });

      if (!response.ok || !response.body) {
        alert("Failed to get audio stream");
        setIsPlaying(false);
        return;
      }

      if (isStreamingMode) {
        await playStreamingAudio(response);
      } else {
        await playFullAudio(response);
      }

      setIsPlaying(false);
    } catch (error) {
      console.error("Audio streaming error:", error);
      alert("Error during audio streaming: " + error.message);
      setIsPlaying(false);
    }
  };

  return (
    <div style={{ 
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      padding: "30px",
      maxWidth: "800px",
      margin: "0 auto",
      backgroundColor: "#f8f9fa",
      borderRadius: "12px",
      boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)"
    }}>
      <h2 style={{
        color: "#1a73e8",
        marginBottom: "24px",
        fontSize: "28px",
        fontWeight: "600"
      }}>Text to Speech Player</h2>

      <div style={{ marginBottom: "24px" }}>
        <div style={{ 
          marginBottom: "20px",
          backgroundColor: "white",
          padding: "20px",
          borderRadius: "8px",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)"
        }}>
          <label style={{ 
            display: "block", 
            marginBottom: "8px",
            color: "#444",
            fontWeight: "500"
          }}>API URL</label>
          <div style={{ display: "flex", gap: "10px" }}>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="Enter TTS API URL"
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px",
                transition: "border-color 0.2s",
                outline: "none"
              }}
              disabled={isPlaying}
            />
            <button
              onClick={clearSettings}
              disabled={isPlaying || !apiUrl}
              style={{
                padding: "10px 16px",
                backgroundColor: isPlaying || !apiUrl ? "#ddd" : "#dc3545",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: isPlaying || !apiUrl ? "not-allowed" : "pointer",
                transition: "background-color 0.2s",
                fontWeight: "500",
                minWidth: "120px"
              }}
            >
              Clear Settings
            </button>
          </div>
        </div>

        <div style={{ 
          display: "grid", 
          gridTemplateColumns: "1fr 1fr", 
          gap: "20px",
          marginBottom: "20px" 
        }}>
          <div style={{ 
            backgroundColor: "white",
            padding: "20px",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)"
          }}>
            <label style={{ 
              display: "block", 
              marginBottom: "8px",
              color: "#444",
              fontWeight: "500"
            }}>Language</label>
            <input
              type="text"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="Enter language code (e.g. en, hi, fr)"
              disabled={isPlaying}
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px"
              }}
            />
          </div>

          <div style={{ 
            backgroundColor: "white",
            padding: "20px",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)"
          }}>
            <label style={{ 
              display: "block", 
              marginBottom: "8px",
              color: "#444",
              fontWeight: "500"
            }}>Voice Gender</label>
            <input
              type="text"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              placeholder="Enter gender (female/male)"
              disabled={isPlaying}
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px"
              }}
            />
          </div>
        </div>

        <div style={{ 
          backgroundColor: "white",
          padding: "20px",
          borderRadius: "8px",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
          marginBottom: "20px"
        }}>
          <label style={{ 
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "#444",
            fontWeight: "500"
          }}>
            <input
              type="checkbox"
              checked={isStreamingMode}
              onChange={(e) => setIsStreamingMode(e.target.checked)}
              disabled={isPlaying}
              style={{
                width: "16px",
                height: "16px"
              }}
            />
            Streaming Mode
            <span style={{ 
              fontSize: "14px",
              color: "#666",
              fontWeight: "normal"
            }}>
              ({isStreamingMode ? "Play chunk by chunk" : "Play complete audio"})
            </span>
          </label>
        </div>

        <div style={{ 
          backgroundColor: "white",
          padding: "20px",
          borderRadius: "8px",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)"
        }}>
          <label style={{ 
            display: "block", 
            marginBottom: "8px",
            color: "#444",
            fontWeight: "500"
          }}>Text to Convert</label>
          <textarea
            rows={5}
            placeholder="Paste your text here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isPlaying}
            style={{
              padding: "12px",
              width: "100%",
              border: "1px solid #ddd",
              borderRadius: "6px",
              fontSize: "14px",
              resize: "vertical",
              minHeight: "120px",
              fontFamily: "inherit"
            }}
          />
        </div>
      </div>

      <button
        onClick={playAudio}
        disabled={isPlaying || !apiUrl}
        style={{
          padding: "12px 24px",
          backgroundColor: isPlaying || !apiUrl ? "#ddd" : "#1a73e8",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: (isPlaying || !apiUrl) ? "not-allowed" : "pointer",
          fontSize: "16px",
          fontWeight: "500",
          transition: "background-color 0.2s",
          width: "100%"
        }}
      >
        {isPlaying ? "Playing..." : "Convert to Speech"}
      </button>
    </div>
  );
};

export default TTSPlayer;

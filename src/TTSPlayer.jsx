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

  useEffect(() => {
    localStorage.setItem('ttsApiUrl', apiUrl);
  }, [apiUrl]);

  const clearUrl = () => {
    setApiUrl('');
    localStorage.removeItem('ttsApiUrl');
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
          language: "en",
          gender: "female",
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
    <div style={{ fontFamily: "sans-serif", padding: "20px" }}>
      <h2>TTS Stream Player (PCM16 → Float32)</h2>

      <div style={{ marginBottom: "20px" }}>
        <div style={{ marginBottom: "15px" }}>
          <input
            type="text"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="Enter TTS API URL"
            style={{
              padding: "8px",
              width: "400px",
              marginRight: "10px"
            }}
            disabled={isPlaying}
          />
          <button
            onClick={clearUrl}
            disabled={isPlaying || !apiUrl}
            style={{
              padding: "8px 16px",
              cursor: isPlaying || !apiUrl ? "not-allowed" : "pointer"
            }}
          >
            Clear URL
          </button>
        </div>

        <label style={{ marginRight: "10px" }}>
          <input
            type="checkbox"
            checked={isStreamingMode}
            onChange={(e) => setIsStreamingMode(e.target.checked)}
            disabled={isPlaying}
          />
          Streaming Mode
        </label>
        <span style={{ fontSize: "0.9em", color: "#666" }}>
          ({isStreamingMode ? "Play chunk by chunk" : "Play complete audio"})
        </span>
      </div>
      <textarea
        rows={5}
        cols={60}
        placeholder="Paste your text here..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={isPlaying}
      />
      <br />
      <button
        onClick={playAudio}
        disabled={isPlaying || !apiUrl}
        style={{
          marginTop: "10px",
          padding: "8px 16px",
          fontSize: "16px",
          cursor: (isPlaying || !apiUrl) ? "not-allowed" : "pointer",
        }}
      >
        {isPlaying ? "Playing..." : "Play"}
      </button>
    </div>
  );
};

export default TTSPlayer;

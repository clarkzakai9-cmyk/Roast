import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';

// --- Audio Utility Functions ---

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function createBlob(data: Float32Array): Blob {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      int16[i] = data[i] * 32768;
    }
    return {
      data: encode(new Uint8Array(int16.buffer)),
      mimeType: 'audio/pcm;rate=16000',
    };
  }

// --- React Component ---

const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
type Transcript = { speaker: 'user' | 'ai'; text: string };

const App = () => {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [status, setStatus] = useState('Welcome to kaitalk! Select a voice and press Start.');
  
  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());

  const startSession = async () => {
    setStatus('Connecting...');
    setTranscripts([]);
    currentInputRef.current = '';
    currentOutputRef.current = '';
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      
      // FIX: Cast window to any to support webkitAudioContext for older browsers.
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextStartTimeRef.current = 0;
      sourcesRef.current.clear();
      
      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: async () => {
            setStatus('Microphone access...');
            mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
            // FIX: Cast window to any to support webkitAudioContext for older browsers.
            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            
            mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);

            scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromiseRef.current?.then((session: any) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
            setIsSessionActive(true);
            setStatus('Listening... Speak now!');
          },
          onmessage: async (message: LiveServerMessage) => {
             if (message.serverContent?.outputTranscription) {
                const text = message.serverContent.outputTranscription.text;
                currentOutputRef.current += text;
                setTranscripts(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.speaker === 'ai') {
                        return [...prev.slice(0, -1), { speaker: 'ai', text: currentOutputRef.current }];
                    }
                    return [...prev, { speaker: 'ai', text: currentOutputRef.current }];
                });
             } else if (message.serverContent?.inputTranscription) {
                const text = message.serverContent.inputTranscription.text;
                currentInputRef.current += text;
                 setTranscripts(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.speaker === 'user') {
                        return [...prev.slice(0, -1), { speaker: 'user', text: currentInputRef.current }];
                    }
                    return [...prev, { speaker: 'user', text: currentInputRef.current }];
                });
             }

             if (message.serverContent?.turnComplete) {
                currentInputRef.current = '';
                currentOutputRef.current = '';
             }

             const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
             if (base64Audio && outputAudioContextRef.current) {
                 const outputAudioContext = outputAudioContextRef.current;
                 nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
                 
                 const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);

                 const source = outputAudioContext.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(outputAudioContext.destination);
                 source.addEventListener('ended', () => { sourcesRef.current.delete(source); });
                 source.start(nextStartTimeRef.current);
                 nextStartTimeRef.current += audioBuffer.duration;
                 sourcesRef.current.add(source);
             }

             if (message.serverContent?.interrupted) {
                 for (const source of sourcesRef.current.values()) {
                     source.stop();
                 }
                 sourcesRef.current.clear();
                 nextStartTimeRef.current = 0;
             }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            setStatus(`Error: ${e.message}. Please try again.`);
            stopSession();
          },
          onclose: (e: CloseEvent) => {
            stopSession();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
        },
      });

    } catch (error) {
      console.error('Failed to start session:', error);
      setStatus('Failed to start. Check permissions and console.');
      setIsSessionActive(false);
    }
  };

  const stopSession = () => {
    if (!isSessionActive && !sessionPromiseRef.current) return;
    
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then((session: any) => session.close());
      sessionPromiseRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;
    
    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;
    
    mediaStreamSourceRef.current?.disconnect();
    mediaStreamSourceRef.current = null;
    
    inputAudioContextRef.current?.close().catch(console.error);
    inputAudioContextRef.current = null;
    
    outputAudioContextRef.current?.close().catch(console.error);
    outputAudioContextRef.current = null;
    
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();

    setIsSessionActive(false);
    setStatus('Session stopped. Press Start to talk again.');
  };

  useEffect(() => {
    if (transcriptContainerRef.current) {
        transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcripts]);

  useEffect(() => {
    return () => { stopSession(); };
  }, []);
  
  const handleToggleSession = () => {
    if (isSessionActive) {
      stopSession();
    } else {
      startSession();
    }
  };

  return (
    <div className="container">
      <h1>kaitalk</h1>
      <div className="transcript-container" ref={transcriptContainerRef} aria-live="polite">
        {transcripts.map((t, i) => (
          <p key={i} className={`transcript-bubble ${t.speaker}`}>
            <strong>{t.speaker === 'user' ? 'You' : 'Kai'}:</strong> {t.text}
          </p>
        ))}
        {!transcripts.length && <p style={{color: '#888', alignSelf: 'center'}}>Conversation will appear here...</p>}
      </div>
      <div className="controls">
        <div className="voice-selector">
          <label htmlFor="voice">AI Voice:</label>
          <select 
            id="voice" 
            value={selectedVoice} 
            onChange={e => setSelectedVoice(e.target.value)}
            disabled={isSessionActive}
            aria-label="Select AI Voice"
          >
            {VOICES.map(voice => <option key={voice} value={voice}>{voice}</option>)}
          </select>
        </div>
        <button onClick={handleToggleSession} className={isSessionActive ? 'stop-button' : 'start-button'}>
          {isSessionActive ? 'Stop' : 'Start'}
        </button>
      </div>
      <p className="status">{status}</p>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
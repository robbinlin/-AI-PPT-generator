
import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { SlideScript } from '../types';
import { CopyIcon, CheckIcon, SpeakerIcon, StopIcon, ChatIcon, PlayCircleIcon, StopCircleIcon, DownloadIcon, VideoCameraIcon, MusicalNoteIcon, FileIcon } from './Icons';
import { generateSpeech, summarizeScript } from '../services/geminiService';
import Chatbot from './Chatbot';

// Allow pdfjsLib to be used from the global scope after being loaded from the CDN
declare const pdfjsLib: any;

// Audio decoding helpers
const decode = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const decodeAudioData = async (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> => {
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
};

// Helper to draw wrapped text on a canvas
const wrapText = (context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) => {
    const lines = text.split('\n');

    for (const textBlock of lines) {
        if (textBlock === '') {
            y += lineHeight;
            continue;
        }
        let currentLine = '';
        for (let i = 0; i < textBlock.length; i++) {
            const char = textBlock[i];
            const testLine = currentLine + char;
            const metrics = context.measureText(testLine);
            if (metrics.width > maxWidth && currentLine.length > 0) {
                context.fillText(currentLine, x, y);
                currentLine = char;
                y += lineHeight;
            } else {
                currentLine = testLine;
            }
        }
        context.fillText(currentLine, x, y);
        y += lineHeight;
    }
};

const formatDuration = (seconds: number | undefined): string | null => {
    if (seconds === undefined || seconds === null) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

// Helper to convert AudioBuffer to a WAV file Blob
const audioBufferToWav = (buffer: AudioBuffer): Blob => {
    const numOfChan = buffer.numberOfChannels;
    const
    len = buffer.length * numOfChan * 2 + 44;
    const
    wavBuffer = new ArrayBuffer(len);
    const
    view = new DataView(wavBuffer);
    const
    channels = [];
    let i;
    let sample;
    let offset = 0;
    let pos = 0;

    // write WAVE header
    setUint32(0x46464952); // "RIFF"
    setUint32(len - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit
    setUint32(0x61746164); // "data" - chunk
    setUint32(len - pos - 4); // chunk length

    // write interleaved data
    for (i = 0; i < buffer.numberOfChannels; i++)
        channels.push(buffer.getChannelData(i));

    while (pos < len) {
        for (i = 0; i < numOfChan; i++) { // interleave channels
            sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
            view.setInt16(pos, sample, true); // write 16-bit sample
            pos += 2;
        }
        offset++ // next source sample
    }

    return new Blob([view], {
        type: 'audio/wav'
    });

    function setUint16(data: number) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data: number) {
        view.setUint32(pos, data, true);
        pos += 4;
    }
}


interface ScriptViewerProps {
  scripts: SlideScript[];
  file: File;
  fileName: string;
  onReset: () => void;
}

const ScriptViewer: React.FC<ScriptViewerProps> = ({ scripts, file, fileName, onReset }) => {
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [localScripts, setLocalScripts] = useState<SlideScript[]>(scripts);
  const [copied, setCopied] = useState(false);
  
  const [currentlyPlayingIndex, setCurrentlyPlayingIndex] = useState<number | null>(null);
  const [isGeneratingAudioFor, setIsGeneratingAudioFor] = useState<number | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [isPdfLoading, setIsPdfLoading] = useState(true);
  
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);


  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isPlayingAllRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<any | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any | null>(null);


  const documentContext = useMemo(() => {
    return scripts.map((s, i) => `頁碼 ${i + 1}: "${s.title}"\n內容:\n${s.script}`).join('\n\n---\n\n');
  }, [scripts]);

  useEffect(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    
    // Close export menu on click outside
    const handleClickOutside = (event: MouseEvent) => {
        if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
          setIsExportMenuOpen(false);
        }
    };
    document.addEventListener('mousedown', handleClickOutside);
    
    return () => {
      stopCurrentAudio();
      isPlayingAllRef.current = false;
      audioContextRef.current?.close();
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    const loadPdf = async () => {
      if (!file || typeof pdfjsLib === 'undefined') return;
      setIsPdfLoading(true);
      try {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const arrayBuffer = event.target?.result;
          if (arrayBuffer) {
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;
            pdfDocRef.current = pdf;
            setIsPdfLoading(false); // PDF loaded, now we can render pages
          }
        };
        reader.readAsArrayBuffer(file);
      } catch (error) {
        console.error("載入 PDF 時發生錯誤:", error);
        setIsPdfLoading(false);
      }
    };
    loadPdf();
  }, [file]);

  useEffect(() => {
    const renderPage = async () => {
        if (!pdfDocRef.current || !canvasRef.current || isPdfLoading) return;

        if (renderTaskRef.current) {
            renderTaskRef.current.cancel();
        }

        const canvas = canvasRef.current;
        const container = canvas.parentElement;
        if (!container) return;

        const pageNumber = activeSlideIndex + 1;
        if (pageNumber > pdfDocRef.current.numPages) return;

        try {
            const page = await pdfDocRef.current.getPage(pageNumber);
            
            const viewportDefault = page.getViewport({ scale: 1 });
            const scale = Math.min(container.clientWidth / viewportDefault.width, container.clientHeight / viewportDefault.height);
            const viewport = page.getViewport({ scale });

            const context = canvas.getContext('2d');

            if (context) {
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                const renderContext = {
                    canvasContext: context,
                    viewport: viewport,
                };
                const renderTask = page.render(renderContext);
                renderTaskRef.current = renderTask;
                
                await renderTask.promise;
                renderTaskRef.current = null;
            }
        } catch(error: any) {
             if (error.name !== 'RenderingCancelledException') {
                console.error(`渲染頁面 ${pageNumber} 時發生錯誤`, error);
            }
        }
    };

    const handleResize = () => renderPage();
    window.addEventListener('resize', handleResize);
    renderPage();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    }

  }, [activeSlideIndex, isPdfLoading]);

  const stopCurrentAudio = () => {
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null; // Prevent onended from firing on manual stop
      audioSourceRef.current.stop();
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
      setCurrentlyPlayingIndex(null);
    }
  };

  const playAudioPromise = (index: number): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      if (!audioContextRef.current) return reject(new Error("AudioContext not initialized"));
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      
      setIsGeneratingAudioFor(index);
      setActiveSlideIndex(index);
      setCopied(false);
  
      try {
        const base64Audio = await generateSpeech(scripts[index].script);
        const audioBytes = decode(base64Audio);
        const audioBuffer = await decodeAudioData(audioBytes, audioContextRef.current, 24000, 1);
        
        const duration = audioBuffer.duration;
        setLocalScripts(prev => {
            const newScripts = [...prev];
            if (newScripts[index].audioDuration !== duration) {
                newScripts[index] = { ...newScripts[index], audioDuration: duration };
                return newScripts;
            }
            return prev;
        });
        
        stopCurrentAudio(); // Stop any previously playing audio
  
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextRef.current.destination);
        source.onended = () => {
          if (audioSourceRef.current === source) {
            setCurrentlyPlayingIndex(null);
            audioSourceRef.current = null;
          }
          resolve();
        };
        source.start();
  
        audioSourceRef.current = source;
        setCurrentlyPlayingIndex(index);
  
      } catch (error) {
        console.error(error);
        alert(error instanceof Error ? error.message : "生成語音時發生未知錯誤");
        reject(error);
      } finally {
        setIsGeneratingAudioFor(null);
      }
    });
  };

  const stopPlayAll = () => {
    isPlayingAllRef.current = false;
    setIsPlayingAll(false);
    stopCurrentAudio();
  };
  
  const startPlayAll = async () => {
    if (isPlayingAllRef.current) return;
    setIsPlayingAll(true);
    isPlayingAllRef.current = true;
  
    for (let i = activeSlideIndex; i < scripts.length; i++) {
      if (!isPlayingAllRef.current) break;
      try {
        await playAudioPromise(i);
      } catch (e) {
        console.error(`播放第 ${i + 1} 頁時發生錯誤，已停止播放。`);
        break; 
      }
    }
    stopPlayAll();
  };

  const handlePlayAllToggle = () => {
    if (isPlayingAllRef.current) {
      stopPlayAll();
    } else {
      startPlayAll();
    }
  };

  const handlePlayAudio = async (index: number) => {
    if (isPlayingAllRef.current) {
      stopPlayAll();
    }
    if (currentlyPlayingIndex === index) {
      stopCurrentAudio();
      return;
    }
    await playAudioPromise(index).catch(() => {});
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(localScripts[activeSlideIndex].script);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const handleSelectSlide = (index: number) => {
    setActiveSlideIndex(index);
    setCopied(false);
  }

  const triggerDownload = (blob: Blob, extension: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.pdf$/i, '')}.${extension}`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleExport = async (type: 'video' | 'audio' | 'script') => {
    setIsExportMenuOpen(false);
    if (!pdfDocRef.current && type === 'video') {
        alert("PDF 尚未完全載入，無法匯出影片。");
        return;
    }
    setIsExporting(true);

    try {
        if (type === 'script') {
            await exportScript();
        } else if (type === 'audio') {
            await exportAudio();
        } else if (type === 'video') {
            await exportVideo();
        }
    } catch (error) {
        console.error(`匯出 ${type} 時發生錯誤:`, error);
        alert(error instanceof Error ? `匯出失敗: ${error.message}` : "發生未知錯誤");
    } finally {
        setIsExporting(false);
        setExportProgress('');
    }
  };

  const exportScript = async () => {
    setExportProgress('正在匯出講稿...');
    const fullScript = localScripts.map((s, i) => 
      `頁碼 ${i + 1}: ${s.title}\n\n${s.script}`
    ).join('\n\n--------------------------------------------------\n\n');
    const blob = new Blob([fullScript], { type: 'text/plain;charset=utf-8' });
    triggerDownload(blob, 'txt');
  };

  const pregenerateAllAudio = async (onProgress: (i: number, total: number) => void): Promise<{ buffers: AudioBuffer[], durations: number[], context: AudioContext }> => {
    const exportAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    const audioBuffers: AudioBuffer[] = [];
    const slideDurations: number[] = [];

    for (let i = 0; i < localScripts.length; i++) {
        onProgress(i + 1, localScripts.length);
        try {
            const base64Audio = await generateSpeech(localScripts[i].script);
            const audioBytes = decode(base64Audio);
            const audioBuffer = await decodeAudioData(audioBytes, exportAudioContext, 24000, 1);
            audioBuffers.push(audioBuffer);
            slideDurations.push(audioBuffer.duration);
        } catch (e) {
            exportAudioContext.close();
            throw new Error(`生成第 ${i + 1} 頁音訊時失敗`);
        }
    }
    
    // Update UI with durations
    setLocalScripts(prev => prev.map((s, i) => ({ ...s, audioDuration: slideDurations[i] })));

    return { buffers: audioBuffers, durations: slideDurations, context: exportAudioContext };
  };

  const exportAudio = async () => {
    const { buffers, context } = await pregenerateAllAudio((i, total) => {
        setExportProgress(`正在生成音訊 ${i}/${total}...`);
    });

    try {
        setExportProgress('正在合併音軌...');
        const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
        const concatenatedAudio = context.createBuffer(1, totalLength, 24000);
        let offset = 0;
        for (const buffer of buffers) {
            concatenatedAudio.copyToChannel(buffer.getChannelData(0), 0, offset);
            offset += buffer.length;
        }

        const wavBlob = audioBufferToWav(concatenatedAudio);
        triggerDownload(wavBlob, 'wav');
    } finally {
        context.close();
    }
  };

  const pregenerateKeyPoints = async (onProgress: (i: number, total: number) => void): Promise<SlideScript[]> => {
    const scriptsToSummarize = [...localScripts];
    const allKeyPoints: string[] = [];
    for (let i = 0; i < scriptsToSummarize.length; i++) {
        onProgress(i + 1, scriptsToSummarize.length);
        try {
            const points = await summarizeScript(scriptsToSummarize[i].script);
            allKeyPoints.push(points);
        } catch (e) {
            throw new Error(`生成第 ${i + 1} 頁重點時失敗`);
        }
    }
    
    const updatedScripts = scriptsToSummarize.map((s, i) => ({ ...s, keyPoints: allKeyPoints[i] }));
    // Update state for UI consistency, though the export will use the returned value.
    setLocalScripts(updatedScripts);
    return updatedScripts;
  };


  const exportVideo = async () => {
    let audioContext: AudioContext | null = null;
    let recorder: MediaRecorder | null = null;
    let animationFrameId: number;
    let allTracks: MediaStreamTrack[] = [];

    const cleanup = () => {
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        }
        cancelAnimationFrame(animationFrameId);
        allTracks.forEach(track => track.stop());
        audioContext?.close();
    };

    try {
        const { buffers, durations, context } = await pregenerateAllAudio((i, total) => {
            setExportProgress(`正在生成音訊 ${i}/${total}...`);
        });
        audioContext = context;

        const scriptsWithKeyPoints = await pregenerateKeyPoints((i, total) => {
            setExportProgress(`正在生成重點 ${i}/${total}...`);
        });

        setExportProgress('正在合併音軌...');
        const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
        const concatenatedAudio = context.createBuffer(1, totalLength, 24000);
        let offset = 0;
        for (const buffer of buffers) {
            concatenatedAudio.copyToChannel(buffer.getChannelData(0), 0, offset);
            offset += buffer.length;
        }

        const audioDestination = context.createMediaStreamDestination();
        const audioSource = context.createBufferSource();
        audioSource.buffer = concatenatedAudio;
        audioSource.connect(audioDestination);
        const [audioTrack] = audioDestination.stream.getAudioTracks();
        
        const VIDEO_WIDTH = 1920;
        const VIDEO_HEIGHT = 1080;

        const videoCanvas = document.createElement('canvas');
        videoCanvas.width = VIDEO_WIDTH;
        videoCanvas.height = VIDEO_HEIGHT;
        const videoCtx = videoCanvas.getContext('2d', { alpha: false });
        if (!videoCtx) throw new Error("無法建立主 Canvas Context");

        const renderCanvas = document.createElement('canvas');
        renderCanvas.width = VIDEO_WIDTH;
        renderCanvas.height = VIDEO_HEIGHT;
        const renderCtx = renderCanvas.getContext('2d', { alpha: false });
        if (!renderCtx) throw new Error("無法建立渲染 Canvas Context");
        
        const videoStream = videoCanvas.captureStream(30);
        const [videoTrack] = videoStream.getVideoTracks();
        
        allTracks = [videoTrack, audioTrack];
        const combinedStream = new MediaStream(allTracks);
        recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm; codecs=vp9,opus' });
        const recordedChunks: Blob[] = [];

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) recordedChunks.push(event.data);
        };
        recorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            triggerDownload(blob, 'webm');
            cleanup();
        };
        recorder.onerror = (event) => {
            // FIX: The type `MediaRecorderErrorEvent` is not available in all TS DOM lib versions.
            // Cast to `any` to access the `error` property.
            const error = (event as any).error;
            console.error("MediaRecorder Error:", error);
            let message = "錄製時發生未知錯誤。";
            if (error) {
                message = `錄製失敗: ${error.name} - ${error.message}`;
            }
            alert(message);
            cleanup();
        }

        const pdfPages: any[] = [];
        for(let i=1; i<= pdfDocRef.current.numPages; i++){
            pdfPages.push(await pdfDocRef.current.getPage(i));
        }

        const renderSlide = async (slideIndex: number) => {
          // Main background
          renderCtx.fillStyle = '#0f172a';
          renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
      
          // --- Left Side: PDF Slide ---
          const pdfArea = { width: 1280, height: 1080, x: 0, y: 0 };
          const page = pdfPages[slideIndex];
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(pdfArea.width / viewport.width, pdfArea.height / viewport.height) * 0.95;
          const scaledViewport = page.getViewport({ scale });
          const pdfX = pdfArea.x + (pdfArea.width - scaledViewport.width) / 2;
          const pdfY = pdfArea.y + (pdfArea.height - scaledViewport.height) / 2;
          
          renderCtx.save();
          renderCtx.translate(pdfX, pdfY);
          await page.render({ canvasContext: renderCtx, viewport: scaledViewport }).promise;
          renderCtx.restore();
          
          // --- Right Side: Key Points & Script ---
          const rightPanelX = 1280;
          const rightPanelWidth = 640;
          const padding = 40;

          // Background for the entire right panel
          renderCtx.fillStyle = '#1e293b';
          renderCtx.fillRect(rightPanelX, 0, rightPanelWidth, 1080);
          
          const currentData = scriptsWithKeyPoints[slideIndex];

          // --- Top half: Key Points ---
          const keyPointsArea = { x: rightPanelX, y: 0, width: rightPanelWidth, height: 540 };
          renderCtx.fillStyle = '#f1f5f9'; // Title color
          renderCtx.font = 'bold 28px sans-serif';
          renderCtx.fillText("本頁重點", keyPointsArea.x + padding, keyPointsArea.y + padding + 30);
          
          renderCtx.fillStyle = '#e2e8f0'; // Text color
          renderCtx.font = '24px sans-serif'; // Larger font for key points
          if (currentData.keyPoints) {
              wrapText(renderCtx, currentData.keyPoints, keyPointsArea.x + padding, keyPointsArea.y + padding + 80, keyPointsArea.width - padding*2, 40);
          }

          // Separator line
          renderCtx.strokeStyle = '#475569';
          renderCtx.lineWidth = 2;
          renderCtx.beginPath();
          renderCtx.moveTo(rightPanelX + padding / 2, 540);
          renderCtx.lineTo(rightPanelX + rightPanelWidth - padding / 2, 540);
          renderCtx.stroke();
          
          // --- Bottom half: Full Script ---
          const scriptArea = { x: rightPanelX, y: 540, width: rightPanelWidth, height: 540 };
          
          renderCtx.fillStyle = '#f1f5f9';
          renderCtx.font = 'bold 24px sans-serif';
          renderCtx.fillText("原始講稿", scriptArea.x + padding, scriptArea.y + padding + 20);

          renderCtx.fillStyle = '#cbd5e1';
          renderCtx.font = '18px sans-serif'; // Smaller font for full script
          wrapText(renderCtx, currentData.script, scriptArea.x + padding, scriptArea.y + padding + 60, scriptArea.width - padding*2, 28);

          videoCtx.drawImage(renderCanvas, 0, 0);
        };
        
        setExportProgress('正在準備第一幀...');
        await renderSlide(0);
        await new Promise(resolve => requestAnimationFrame(resolve));

        const slideEndTimes: number[] = durations.reduce((acc, duration, i) => {
            acc.push((acc[i-1] || 0) + duration);
            return acc;
        }, [] as number[]);
        const totalDuration = slideEndTimes[slideEndTimes.length - 1];
        let lastRenderedSlide = 0;
        const startTime = audioContext.currentTime;

        const renderLoop = async () => {
            if (!audioContext || !recorder || recorder.state !== 'recording') {
                return;
            }

            const elapsedTime = audioContext.currentTime - startTime;

            if (elapsedTime >= totalDuration) {
                if (lastRenderedSlide < scriptsWithKeyPoints.length - 1) {
                    setExportProgress(`正在渲染最後一幀...`);
                    await renderSlide(scriptsWithKeyPoints.length - 1);
                }
                if (recorder.state === 'recording') recorder.stop();
                return;
            }

            const currentSlideIndex = slideEndTimes.findIndex(endTime => elapsedTime < endTime);

            if (currentSlideIndex !== -1 && currentSlideIndex !== lastRenderedSlide) {
                lastRenderedSlide = currentSlideIndex;
                setExportProgress(`正在渲染影片 ${currentSlideIndex + 1}/${scriptsWithKeyPoints.length}...`);
                await renderSlide(currentSlideIndex);
            }

            animationFrameId = requestAnimationFrame(renderLoop);
        };
        
        recorder.start();
        audioSource.start();
        animationFrameId = requestAnimationFrame(renderLoop);

    } catch (error) {
        cleanup();
        throw error;
    }
  };

  const activeScript = localScripts[activeSlideIndex];

  return (
    <div className="w-full h-full flex flex-col p-4 sm:p-6 lg:p-8 bg-slate-900 relative">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-4 border-b border-slate-700">
        <div>
            <h1 className="text-2xl lg:text-3xl font-bold text-white">講稿生成結果</h1>
            <p className="text-sm text-slate-400 mt-1">檔案: {fileName}</p>
        </div>
        <div className="flex items-center space-x-2 sm:space-x-4 mt-4 sm:mt-0">
          <button
              onClick={handlePlayAllToggle}
              className="flex items-center space-x-2 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-3 sm:px-4 rounded-lg transition-colors duration-200 disabled:bg-green-800 disabled:cursor-not-allowed"
              disabled={isGeneratingAudioFor !== null || isExporting}
          >
              {isPlayingAll ? (
                  <>
                      <StopCircleIcon className="w-5 h-5" />
                      <span className="hidden sm:inline">停止播放</span>
                  </>
              ) : (
                  <>
                      <PlayCircleIcon className="w-5 h-5" />
                      <span className="hidden sm:inline">全部播放</span>
                  </>
              )}
          </button>
          
          <div className="relative" ref={exportMenuRef}>
            <div className="flex flex-col items-end">
                <button
                onClick={() => setIsExportMenuOpen(prev => !prev)}
                className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-3 sm:px-4 rounded-lg transition-colors duration-200 disabled:bg-indigo-800 disabled:cursor-not-allowed"
                disabled={isExporting}
                >
                {isExporting ? (
                    <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span className="hidden sm:inline text-sm">{exportProgress || '匯出中...'}</span>
                    </>
                ) : (
                    <>
                        <DownloadIcon className="w-5 h-5" />
                        <span className="hidden sm:inline">匯出</span>
                    </>
                )}
                </button>
                {isExporting && (
                     <p className="text-xs text-slate-400 mt-2 text-right">匯出過程可能需要數分鐘，<br/>請保持此分頁為前景以確保成功。</p>
                )}
            </div>
            {isExportMenuOpen && !isExporting && (
                <div className="absolute right-0 mt-2 w-56 origin-top-right bg-slate-700 divide-y divide-slate-600 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none z-10">
                    <div className="py-1">
                        <button onClick={() => handleExport('video')} className="text-slate-200 hover:bg-indigo-500 hover:text-white group flex rounded-md items-center w-full px-4 py-2 text-sm">
                            <VideoCameraIcon className="mr-3 h-5 w-5 text-slate-400 group-hover:text-white" />
                            匯出完整影片 (.webm)
                        </button>
                        <button onClick={() => handleExport('audio')} className="text-slate-200 hover:bg-indigo-500 hover:text-white group flex rounded-md items-center w-full px-4 py-2 text-sm">
                            <MusicalNoteIcon className="mr-3 h-5 w-5 text-slate-400 group-hover:text-white" />
                            僅匯出音訊 (.wav)
                        </button>
                        <button onClick={() => handleExport('script')} className="text-slate-200 hover:bg-indigo-500 hover:text-white group flex rounded-md items-center w-full px-4 py-2 text-sm">
                            <FileIcon className="mr-3 h-5 w-5 text-slate-400 group-hover:text-white" />
                            僅匯出講稿 (.txt)
                        </button>
                    </div>
                </div>
            )}
          </div>

          <button
            onClick={() => {
              stopPlayAll();
              onReset();
            }}
            className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 px-3 sm:px-4 rounded-lg transition-colors duration-200"
            disabled={isExporting}
          >
            新檔案
          </button>
        </div>
      </header>

      {/* Main Layout Container */}
      <div className="flex-grow flex flex-row gap-6 lg:gap-8 overflow-hidden">
        
        {/* Left Column: Slide Navigation */}
        <nav className="w-1/4 lg:w-1/5 xl:w-1/6 flex-shrink-0 bg-slate-800 rounded-xl p-4 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4 text-white px-2">文件大綱</h2>
          <ul>
            {localScripts.map((script, index) => (
              <li key={index} className={`flex items-center justify-between p-2 rounded-md transition-all duration-200 ${
                currentlyPlayingIndex === index
                  ? 'bg-green-800/50 ring-2 ring-green-500'
                  : ''
              }`}>
                <button
                  onClick={() => handleSelectSlide(index)}
                  className={`flex-grow text-left p-2 rounded-md w-full flex items-center justify-between ${
                    index === activeSlideIndex
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <span className="truncate pr-2">
                    <span className="font-mono text-sm mr-3 opacity-60">{`${index + 1}`.padStart(2, '0')}</span>
                    {script.title}
                  </span>
                  {script.audioDuration && (
                    <span className="text-xs font-mono text-slate-400 flex-shrink-0">
                      {formatDuration(script.audioDuration)}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handlePlayAudio(index)}
                  disabled={isGeneratingAudioFor !== null || isExporting}
                  className="ml-2 p-2 rounded-full hover:bg-slate-700 disabled:opacity-50 disabled:cursor-wait transition-colors"
                  aria-label={currentlyPlayingIndex === index ? "停止朗讀" : "朗讀講稿"}
                >
                    {isGeneratingAudioFor === index ? (
                        <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></div>
                    ) : currentlyPlayingIndex === index ? (
                        <StopIcon className="w-5 h-5 text-green-400" />
                    ) : (
                        <SpeakerIcon className="w-5 h-5 text-slate-400" />
                    )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Right Column: Main Content Area -> Changed to flex-row */}
        <main className="flex-grow flex flex-row gap-6 lg:gap-8 overflow-hidden">
            {/* PDF Viewer (Left 2/3 of main) */}
            <div className="flex-[2] bg-slate-800 rounded-xl flex items-center justify-center relative overflow-hidden min-h-0">
                <h2 className="absolute top-4 left-4 text-xl font-bold text-white z-10 bg-black/40 p-2 rounded-md">{activeScript.title}</h2>
                 {isPdfLoading ? (
                    <div className="text-center text-slate-400">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-slate-500 mx-auto mb-4"></div>
                        <p>正在載入 PDF...</p>
                    </div>
                ) : (
                    <div className="w-full h-full flex items-center justify-center p-4">
                        <canvas ref={canvasRef} className="max-w-full max-h-full object-contain shadow-2xl"></canvas>
                    </div>
                )}
            </div>

            {/* Script (Right 1/3 of main) */}
            <div className="flex-[1] flex flex-col bg-slate-800 rounded-xl overflow-hidden min-h-0">
                <div className="flex justify-between items-center p-4 flex-shrink-0 border-b border-slate-700">
                    <h3 className="text-lg font-semibold text-slate-300">講稿</h3>
                    <button
                        onClick={handleCopy}
                        className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
                            copied
                            ? 'bg-green-600 text-white'
                            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                        }`}
                    >
                        {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
                        <span>{copied ? '已複製' : '複製'}</span>
                    </button>
                </div>
                <div className="overflow-y-auto p-4">
                    <p className="text-slate-300 leading-relaxed whitespace-pre-wrap text-base">
                        {activeScript.script}
                    </p>
                </div>
            </div>
        </main>
      </div>

      {/* Chatbot */}
      <div className="fixed bottom-8 right-8 z-50">
        <button
          onClick={() => setIsChatOpen(!isChatOpen)}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-full p-4 shadow-lg transform hover:scale-110 transition-all duration-200"
          aria-label="開啟聊天機器人"
        >
          <ChatIcon className="w-8 h-8" />
        </button>
      </div>
      <Chatbot 
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        documentContext={documentContext}
      />
    </div>
  );
};

export default ScriptViewer;

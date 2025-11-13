import React, { useState, useCallback } from 'react';
import FileUpload from './components/FileUpload';
import LoadingSpinner from './components/LoadingSpinner';
import ScriptViewer from './components/ScriptViewer';
import { generateScriptsFromPPT } from './services/geminiService';
import type { SlideScript } from './types';

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
          const result = reader.result as string;
          // result is "data:mime/type;base64,the-real-base64-string"
          // we need to strip the prefix
          const base64String = result.split(',')[1];
          resolve(base64String);
      };
      reader.onerror = error => reject(error);
  });
};

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [scripts, setScripts] = useState<SlideScript[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = useCallback(async (uploadedFile: File) => {
    setIsLoading(true);
    setError(null);
    setFile(uploadedFile);

    try {
      const fileContentBase64 = await fileToBase64(uploadedFile);
      const generatedScripts = await generateScriptsFromPPT(fileContentBase64, uploadedFile.type);
      setScripts(generatedScripts);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("發生未知的錯誤");
      }
      setScripts(null); // Clear previous results on error
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleReset = () => {
    setFile(null);
    setScripts(null);
    setError(null);
    setIsLoading(false);
  };
  
  const renderContent = () => {
    if (isLoading) {
      return <LoadingSpinner />;
    }
    if (error) {
      return (
        <div className="text-center p-8 bg-red-900/50 border border-red-700 rounded-lg">
          <h2 className="text-2xl font-bold text-red-300 mb-4">發生錯誤</h2>
          <p className="text-red-200 mb-6">{error}</p>
          <button
            onClick={handleReset}
            className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg transition-colors duration-200"
          >
            重試
          </button>
        </div>
      );
    }
    if (scripts && file) {
      return <ScriptViewer scripts={scripts} file={file} fileName={file.name} onReset={handleReset} />;
    }
    return <FileUpload onFileUpload={handleFileUpload} isLoading={isLoading} />;
  };

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-slate-900 p-4">
      {scripts && !error && file ? (
        <div className="w-full h-screen">
          {renderContent()}
        </div>
      ) : (
        <div className="w-full max-w-2xl">
          {renderContent()}
        </div>
      )}
    </main>
  );
};

export default App;
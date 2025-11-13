
import React, { useState, useCallback, useRef } from 'react';
import { UploadIcon, FileIcon } from './Icons';

interface FileUploadProps {
  onFileUpload: (file: File) => void;
  isLoading: boolean;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileUpload, isLoading }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (selectedFile: File | null | undefined) => {
    if (selectedFile && (selectedFile.type === 'application/pdf' || selectedFile.name.endsWith('.pdf'))) {
      setFile(selectedFile);
    } else if (selectedFile) {
        alert("請上傳有效的 PDF 檔案 (.pdf)。");
    }
  };

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files?.[0]);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(e.target.files?.[0]);
  };
  
  const onButtonClick = () => {
      fileInputRef.current?.click();
  }

  const handleSubmit = () => {
    if(file) {
        onFileUpload(file);
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto bg-slate-800/50 rounded-2xl shadow-2xl p-8 border border-slate-700 backdrop-blur-sm">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">PDF 講稿生成器</h1>
        <p className="text-slate-400">上傳您的 PDF，讓 AI 為您打造專業講稿</p>
      </div>
      
      {!file ? (
         <div 
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={onButtonClick}
          className={`flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-lg cursor-pointer transition-colors duration-300 ${isDragging ? 'border-blue-500 bg-slate-700/50' : 'border-slate-600 hover:border-slate-500 hover:bg-slate-800/70'}`}
        >
          <div className="flex flex-col items-center justify-center pt-5 pb-6">
            <UploadIcon className="w-10 h-10 mb-3 text-slate-400" />
            <p className="mb-2 text-sm text-slate-400"><span className="font-semibold">點擊選擇檔案</span> 或拖曳至此</p>
            <p className="text-xs text-slate-500">支援 .PDF 檔案</p>
          </div>
          <input ref={fileInputRef} type="file" id="file-upload" className="hidden" onChange={onFileChange} accept=".pdf,application/pdf" />
        </div>
      ) : (
        <div className="text-center">
            <div className="bg-slate-700 rounded-lg p-6 flex flex-col items-center justify-center space-y-4">
                <FileIcon className="w-16 h-16 text-blue-400" />
                <p className="text-lg font-medium text-slate-200 break-all">{file.name}</p>
                <button 
                    onClick={() => setFile(null)} 
                    className="text-sm text-slate-400 hover:text-white transition-colors"
                >
                    更換檔案
                </button>
            </div>
            <button
                onClick={handleSubmit}
                disabled={isLoading}
                className="mt-8 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-lg transition-all duration-300 shadow-lg hover:shadow-blue-500/50 transform hover:-translate-y-1"
            >
                {isLoading ? '生成中...' : '開始生成講稿'}
            </button>
        </div>
      )}

    </div>
  );
};

export default FileUpload;
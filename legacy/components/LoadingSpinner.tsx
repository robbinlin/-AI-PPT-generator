
import React from 'react';

const LoadingSpinner: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center space-y-4">
      <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-blue-500"></div>
      <p className="text-lg text-blue-300">AI 正在為您撰寫講稿，請稍候...</p>
    </div>
  );
};

export default LoadingSpinner;

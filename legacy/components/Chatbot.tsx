import React, { useState, useRef, useEffect } from 'react';
import { askQuestionAboutDocument } from '../services/geminiService';
import type { ChatMessage } from '../types';
import { CloseIcon, SendIcon, UserIcon, BotIcon } from './Icons';

interface ChatbotProps {
  isOpen: boolean;
  onClose: () => void;
  documentContext: string;
}

const Chatbot: React.FC<ChatbotProps> = ({ isOpen, onClose, documentContext }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'bot', content: '你好！我是您的文件問答助理，請問有什麼可以協助您的嗎？' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);
  
  useEffect(() => {
    if (isOpen) {
        // Focus input when chat opens
        setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSend = async () => {
    if (input.trim() === '' || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const botResponse = await askQuestionAboutDocument(documentContext, input);
      setMessages(prev => [...prev, { role: 'bot', content: botResponse }]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '發生未知錯誤';
      setMessages(prev => [...prev, { role: 'bot', content: `抱歉，發生錯誤：${errorMessage}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSend();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed bottom-24 right-8 z-40 w-[90vw] max-w-md h-[70vh] max-h-[600px] bg-slate-800 rounded-2xl shadow-2xl flex flex-col border border-slate-700 overflow-hidden transition-all duration-300">
      {/* Header */}
      <header className="flex items-center justify-between p-4 bg-slate-900/50 border-b border-slate-700 flex-shrink-0">
        <h2 className="text-lg font-bold text-white">文件問答助理</h2>
        <button onClick={onClose} className="p-1 rounded-full text-slate-400 hover:bg-slate-700 hover:text-white transition-colors">
          <CloseIcon className="w-6 h-6" />
        </button>
      </header>

      {/* Messages */}
      <div className="flex-grow p-4 overflow-y-auto space-y-4">
        {messages.map((msg, index) => (
          <div key={index} className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
            {msg.role === 'bot' && (
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                <BotIcon className="w-5 h-5 text-white" />
              </div>
            )}
            <div className={`max-w-xs md:max-w-sm px-4 py-2 rounded-2xl ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-700 text-slate-200 rounded-bl-none'}`}>
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
             {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center flex-shrink-0">
                <UserIcon className="w-5 h-5 text-white" />
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                <BotIcon className="w-5 h-5 text-white" />
            </div>
            <div className="max-w-xs md:max-w-sm px-4 py-3 rounded-2xl bg-slate-700 text-slate-200 rounded-bl-none flex items-center space-x-2">
                <span className="w-2 h-2 bg-slate-400 rounded-full animate-pulse delay-0"></span>
                <span className="w-2 h-2 bg-slate-400 rounded-full animate-pulse delay-200"></span>
                <span className="w-2 h-2 bg-slate-400 rounded-full animate-pulse delay-400"></span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <footer className="p-4 border-t border-slate-700 bg-slate-800 flex-shrink-0">
        <div className="flex items-center bg-slate-700 rounded-full px-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="請在這裡輸入您的問題..."
            disabled={isLoading}
            className="w-full bg-transparent p-3 text-white placeholder-slate-400 focus:outline-none"
          />
          <button onClick={handleSend} disabled={isLoading || input.trim() === ''} className="p-2 rounded-full bg-blue-600 text-white disabled:bg-slate-600 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors">
            <SendIcon className="w-5 h-5" />
          </button>
        </div>
      </footer>
    </div>
  );
};

export default Chatbot;

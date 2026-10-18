export interface SlideScript {
  title: string;
  script: string;
  audioDuration?: number;
  keyPoints?: string;
}

export interface ChatMessage {
  role: 'user' | 'bot';
  content: string;
}

import React from 'react';

interface PanelProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

const Panel: React.FC<PanelProps> = ({ title, children, className = '' }) => {
  return (
    <div className={`bg-[#0C0C0C] h-fit min-h-[700px] border border-[#252525] rounded-lg p-6 ${className}`}>
      <h2 className="text-white text-2xl px-2 font-bold">{title}</h2>
      <div className=" pt-8">
        {children}
      </div>
    </div>
  );
};

export default Panel;

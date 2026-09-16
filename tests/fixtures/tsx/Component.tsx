import React from 'react';

/** 按钮组件（JSX 必须用 tsx 语法才能解析）。 */
export function Button({ label }: { label: string }) {
  return <button className="btn">{label}</button>;
}

export class Panel extends React.Component {
  render() {
    return (
      <div>
        <Button label="hi" />
        {1 > 0 && <span>ok</span>}
      </div>
    );
  }
}

export interface PanelProps {
  title: string;
}

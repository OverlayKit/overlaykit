// Built-in Scene templates offered on the Scenes surface (AC-006 Template branch). Choosing one
// creates a Scene pre-populated with these elements rather than a blank canvas.
export interface TemplateElement {
  id: string;
  tag: string;
  content?: string | null;
  styles: Record<string, string>;
}

export interface SceneTemplate {
  id: string;
  label: string;
  elements: TemplateElement[];
}

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    id: 'lower-third',
    label: 'Lower Third',
    elements: [
      {
        id: 'lt-bar',
        tag: 'div',
        content: null,
        styles: {
          position: 'absolute',
          left: '80px',
          bottom: '120px',
          width: '620px',
          height: '120px',
          background: '#1e293b',
          borderLeft: '6px solid #38bdf8',
          borderRadius: '6px',
        },
      },
      {
        id: 'lt-name',
        tag: 'div',
        content: 'Name',
        styles: {
          position: 'absolute',
          left: '116px',
          bottom: '172px',
          color: '#ffffff',
          fontSize: '44px',
          fontWeight: '700',
        },
      },
      {
        id: 'lt-role',
        tag: 'div',
        content: 'Role',
        styles: {
          position: 'absolute',
          left: '116px',
          bottom: '134px',
          color: '#94a3b8',
          fontSize: '26px',
        },
      },
    ],
  },
];

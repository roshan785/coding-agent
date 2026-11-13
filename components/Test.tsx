export interface TestProps {
  title: string;
}

export default function Test({ title }: TestProps) {
  return <h2 className="text-lg font-semibold">{title}</h2>;
}

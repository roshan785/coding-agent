export interface GreetingProps {
  name: string;
}

export default function Greeting({ name }: GreetingProps) {
  return <p className="text-sm font-medium">Hello, {name}</p>;
}

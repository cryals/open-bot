export function Logo({ className = '' }: { className?: string }) {
  return (
    <img
      className={'product-logo ' + className}
      src="/stopco.png"
      alt=""
      width={100}
      height={100}
      draggable={false}
    />
  );
}

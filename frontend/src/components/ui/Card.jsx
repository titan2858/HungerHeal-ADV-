export default function Card({ as: Tag = 'div', hover = false, className = '', children, ...rest }) {
  return (
    <Tag
      className={[
        'rounded-xl2 border border-cream-200 bg-white p-6 shadow-soft',
        hover ? 'transition-shadow duration-200 hover:shadow-lift' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </Tag>
  );
}

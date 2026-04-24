interface Props {
  label: string;
  count: number;
  colSpan?: number;
}

export function GroupHeader({ label, count, colSpan = 9 }: Props) {
  return (
    <tr className="p2-grp">
      <td colSpan={colSpan}>
        {label}
        <span className="p2-gcount">{count} positions</span>
      </td>
    </tr>
  );
}

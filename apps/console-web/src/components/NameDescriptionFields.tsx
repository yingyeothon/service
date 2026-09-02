import { TextInput } from "@mantine/core";
import { MdField } from "./MdField";

/**
 * The name + description pair of every named resource. Teams and projects
 * carry a markdown description; apps, bundles and sites a plain line.
 */
export function NameDescriptionFields({
  name,
  description,
  onName,
  onDescription,
  markdown,
  nameLabel = "Name",
  namePlaceholder,
}: {
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  markdown?: boolean;
  nameLabel?: string;
  namePlaceholder?: string;
}) {
  return (
    <>
      <TextInput
        label={nameLabel}
        placeholder={namePlaceholder}
        value={name}
        onChange={(e) => onName(e.currentTarget.value)}
        required
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        data-autofocus
      />
      {markdown ? (
        <MdField
          label="Description"
          value={description}
          onChange={onDescription}
        />
      ) : (
        <TextInput
          label="Description"
          placeholder="optional"
          value={description}
          onChange={(e) => onDescription(e.currentTarget.value)}
          maxLength={2000}
          autoComplete="off"
        />
      )}
    </>
  );
}

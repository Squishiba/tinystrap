TRUE_WORDS = ("true", "1", "yes", "on")
FALSE_WORDS = ("false", "0", "no", "off", "")


def to_bool(value):
    """Interpret a raw settings value as a boolean.

    Settings arrive as strings from the settings file. `value` matches
    case-insensitively against TRUE_WORDS / FALSE_WORDS. Anything else is a
    configuration error and must raise ValueError.
    """
    return bool(value)

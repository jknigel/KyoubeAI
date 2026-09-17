# Notices

KyoubeAI
Copyright (C) 2026 KyoubeAI contributors

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Affero General Public License in `LICENSE` for more details.

## Third-party software

### Paperclip

KyoubeAI builds on Paperclip (https://github.com/paperclipai/paperclip), Copyright (c) 2025
Paperclip AI, distributed under the MIT License. The Paperclip image and packages are consumed as
published artifacts; at image build time KyoubeAI applies a branding transform to the image's
user-facing text and artwork (`docker/rebrand/`) and does not otherwise modify them. The MIT
permission notice, reproduced as that licence requires:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Agent harnesses installed into the image

The image build (`docker/Dockerfile`) additionally installs third-party agent CLIs that are not part
of this repository and are distributed under their own licences: Claude Code
(`@anthropic-ai/claude-code`, Anthropic's licence, see the package's README), pi
(`@earendil-works/pi-coding-agent`) and Hermes Agent (https://github.com/NousResearch/hermes-agent).
Their terms apply to those programs, not to KyoubeAI.

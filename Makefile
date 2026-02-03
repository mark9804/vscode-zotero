.PHONY: lint build package check tag release

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)

lint:
	npm run lint

build:
	npm run compile

package: build
	npx vsce package

check:
	@rg -q "^##\\s+$(VERSION)\\b" CHANGELOG.md

tag:
	git tag -a $(TAG) -m "$(TAG)"

release: check package tag
	git push --tags
	gh release create $(TAG) zotero-citation-picker-*.vsix --notes-from-tag

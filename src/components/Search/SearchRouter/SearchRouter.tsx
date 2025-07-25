import {findFocusedRoute, useNavigationState} from '@react-navigation/native';
import {deepEqual} from 'fast-equals';
import React, {forwardRef, useCallback, useEffect, useRef, useState} from 'react';
import type {TextInputProps} from 'react-native';
import {InteractionManager, Keyboard, View} from 'react-native';
import type {ValueOf} from 'type-fest';
import HeaderWithBackButton from '@components/HeaderWithBackButton';
import * as Expensicons from '@components/Icon/Expensicons';
import type {AnimatedTextInputRef} from '@components/RNTextInput';
import type {GetAdditionalSectionsCallback} from '@components/Search/SearchAutocompleteList';
import SearchAutocompleteList from '@components/Search/SearchAutocompleteList';
import SearchInputSelectionWrapper from '@components/Search/SearchInputSelectionWrapper';
import type {SearchQueryString} from '@components/Search/types';
import type {SearchQueryItem} from '@components/SelectionList/Search/SearchQueryListItem';
import {isSearchQueryItem} from '@components/SelectionList/Search/SearchQueryListItem';
import type {SelectionListHandle} from '@components/SelectionList/types';
import useDebouncedState from '@hooks/useDebouncedState';
import useKeyboardShortcut from '@hooks/useKeyboardShortcut';
import useLocalize from '@hooks/useLocalize';
import useOnyx from '@hooks/useOnyx';
import useResponsiveLayout from '@hooks/useResponsiveLayout';
import useThemeStyles from '@hooks/useThemeStyles';
import {scrollToRight} from '@libs/InputUtils';
import Log from '@libs/Log';
import backHistory from '@libs/Navigation/helpers/backHistory';
import type {SearchOption} from '@libs/OptionsListUtils';
import type {OptionData} from '@libs/ReportUtils';
import {getAutocompleteQueryWithComma, getQueryWithoutAutocompletedPart} from '@libs/SearchAutocompleteUtils';
import {getQueryWithUpdatedValues, sanitizeSearchValue} from '@libs/SearchQueryUtils';
import StringUtils from '@libs/StringUtils';
import Navigation from '@navigation/Navigation';
import type {ReportsSplitNavigatorParamList} from '@navigation/types';
import variables from '@styles/variables';
import {navigateToAndOpenReport, searchInServer} from '@userActions/Report';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import SCREENS from '@src/SCREENS';
import type Report from '@src/types/onyx/Report';
import isLoadingOnyxValue from '@src/types/utils/isLoadingOnyxValue';
import type {SubstitutionMap} from './getQueryWithSubstitutions';
import {getQueryWithSubstitutions} from './getQueryWithSubstitutions';
import {getUpdatedSubstitutionsMap} from './getUpdatedSubstitutionsMap';

function getContextualSearchAutocompleteKey(item: SearchQueryItem) {
    if (item.roomType === CONST.SEARCH.DATA_TYPES.INVOICE) {
        return `${CONST.SEARCH.SYNTAX_FILTER_KEYS.TO}:${item.searchQuery}`;
    }
    if (item.roomType === CONST.SEARCH.DATA_TYPES.CHAT) {
        return `${CONST.SEARCH.SYNTAX_FILTER_KEYS.IN}:${item.searchQuery}`;
    }
}

function getContextualSearchQuery(item: SearchQueryItem) {
    const baseQuery = `${CONST.SEARCH.SEARCH_USER_FRIENDLY_KEYS.TYPE}:${item.roomType}`;
    let additionalQuery = '';

    switch (item.roomType) {
        case CONST.SEARCH.DATA_TYPES.EXPENSE:
        case CONST.SEARCH.DATA_TYPES.INVOICE:
            additionalQuery += ` ${CONST.SEARCH.SEARCH_USER_FRIENDLY_KEYS.POLICY_ID}:${item.policyID}`;
            if (item.roomType === CONST.SEARCH.DATA_TYPES.INVOICE && item.autocompleteID) {
                additionalQuery += ` ${CONST.SEARCH.SEARCH_USER_FRIENDLY_KEYS.TO}:${sanitizeSearchValue(item.searchQuery ?? '')}`;
            }
            break;
        case CONST.SEARCH.DATA_TYPES.CHAT:
        default:
            additionalQuery = ` ${CONST.SEARCH.SEARCH_USER_FRIENDLY_KEYS.IN}:${sanitizeSearchValue(item.searchQuery ?? '')}`;
            break;
    }
    return baseQuery + additionalQuery;
}

type SearchRouterProps = {
    onRouterClose: () => void;
    shouldHideInputCaret?: TextInputProps['caretHidden'];
    isSearchRouterDisplayed?: boolean;
};

function SearchRouter({onRouterClose, shouldHideInputCaret, isSearchRouterDisplayed}: SearchRouterProps, ref: React.Ref<View>) {
    const {translate} = useLocalize();
    const styles = useThemeStyles();
    const [, recentSearchesMetadata] = useOnyx(ONYXKEYS.RECENT_SEARCHES, {canBeMissing: true});
    const [isSearchingForReports] = useOnyx(ONYXKEYS.IS_SEARCHING_FOR_REPORTS, {initWithStoredValues: false, canBeMissing: true});

    const {shouldUseNarrowLayout} = useResponsiveLayout();
    const listRef = useRef<SelectionListHandle>(null);

    // The actual input text that the user sees
    const [textInputValue, , setTextInputValue] = useDebouncedState('', 500);
    // The input text that was last used for autocomplete; needed for the SearchAutocompleteList when browsing list via arrow keys
    const [autocompleteQueryValue, setAutocompleteQueryValue] = useState(textInputValue);
    const [selection, setSelection] = useState({start: textInputValue.length, end: textInputValue.length});
    const [autocompleteSubstitutions, setAutocompleteSubstitutions] = useState<SubstitutionMap>({});
    const textInputRef = useRef<AnimatedTextInputRef>(null);

    const contextualReportID = useNavigationState<Record<string, {reportID: string}>, string | undefined>((state) => {
        const focusedRoute = findFocusedRoute(state);
        if (focusedRoute?.name === SCREENS.REPORT) {
            // We're guaranteed that the type of params is of SCREENS.REPORT
            return (focusedRoute.params as ReportsSplitNavigatorParamList[typeof SCREENS.REPORT]).reportID;
        }
    });

    const getAdditionalSections: GetAdditionalSectionsCallback = useCallback(
        ({recentReports}) => {
            if (!contextualReportID) {
                return undefined;
            }

            // We will only show the contextual search suggestion if the user has not typed anything
            if (textInputValue) {
                return undefined;
            }

            if (!isSearchRouterDisplayed) {
                return undefined;
            }

            const reportForContextualSearch = recentReports.find((option) => option.reportID === contextualReportID);
            if (!reportForContextualSearch) {
                return undefined;
            }

            const reportQueryValue = reportForContextualSearch.text ?? reportForContextualSearch.alternateText ?? reportForContextualSearch.reportID;

            let roomType: ValueOf<typeof CONST.SEARCH.DATA_TYPES> = CONST.SEARCH.DATA_TYPES.CHAT;
            let autocompleteID: string | undefined = reportForContextualSearch.reportID;

            if (reportForContextualSearch.isInvoiceRoom) {
                roomType = CONST.SEARCH.DATA_TYPES.INVOICE;
                const report = reportForContextualSearch as SearchOption<Report>;
                if (report.item && report.item?.invoiceReceiver && report.item.invoiceReceiver?.type === CONST.REPORT.INVOICE_RECEIVER_TYPE.INDIVIDUAL) {
                    autocompleteID = report.item.invoiceReceiver.accountID.toString();
                } else {
                    autocompleteID = '';
                }
            }
            if (reportForContextualSearch.isPolicyExpenseChat) {
                roomType = CONST.SEARCH.DATA_TYPES.EXPENSE;
                if (reportForContextualSearch.policyID) {
                    autocompleteID = reportForContextualSearch.policyID;
                } else {
                    autocompleteID = '';
                }
            }

            return [
                {
                    data: [
                        {
                            text: StringUtils.lineBreaksToSpaces(`${translate('search.searchIn')} ${reportForContextualSearch.text ?? reportForContextualSearch.alternateText}`),
                            singleIcon: Expensicons.MagnifyingGlass,
                            searchQuery: reportQueryValue,
                            autocompleteID,
                            itemStyle: styles.activeComponentBG,
                            keyForList: 'contextualSearch',
                            searchItemType: CONST.SEARCH.SEARCH_ROUTER_ITEM_TYPE.CONTEXTUAL_SUGGESTION,
                            roomType,
                            policyID: reportForContextualSearch.policyID,
                        },
                    ],
                },
            ];
        },
        [contextualReportID, styles.activeComponentBG, textInputValue, translate, isSearchRouterDisplayed],
    );

    const searchQueryItem = textInputValue
        ? {
              text: textInputValue,
              singleIcon: Expensicons.MagnifyingGlass,
              searchQuery: textInputValue,
              itemStyle: styles.activeComponentBG,
              keyForList: 'findItem',
              searchItemType: CONST.SEARCH.SEARCH_ROUTER_ITEM_TYPE.SEARCH,
          }
        : undefined;

    const shouldScrollRef = useRef(false);
    // Trigger scrollToRight when input value changes and shouldScroll is true
    useEffect(() => {
        if (!textInputRef.current || !shouldScrollRef.current) {
            return;
        }

        scrollToRight(textInputRef.current);
        shouldScrollRef.current = false;
    }, [textInputValue]);

    const onSearchQueryChange = useCallback(
        (userQuery: string, autoScrollToRight = false) => {
            const actionId = `search_query_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const startTime = Date.now();

            Log.info('[CMD_K_DEBUG] Search query change started', false, {
                actionId,
                inputLength: userQuery.length,
                previousInputLength: textInputValue.length,
                autoScrollToRight,
                timestamp: startTime,
            });

            try {
                if (autoScrollToRight) {
                    shouldScrollRef.current = true;
                }
                const singleLineUserQuery = StringUtils.lineBreaksToSpaces(userQuery, true);
                const updatedUserQuery = getAutocompleteQueryWithComma(textInputValue, singleLineUserQuery);
                setTextInputValue(updatedUserQuery);
                setAutocompleteQueryValue(updatedUserQuery);

                const updatedSubstitutionsMap = getUpdatedSubstitutionsMap(singleLineUserQuery, autocompleteSubstitutions);
                if (!deepEqual(autocompleteSubstitutions, updatedSubstitutionsMap)) {
                    setAutocompleteSubstitutions(updatedSubstitutionsMap);
                }

                if (updatedUserQuery || textInputValue.length > 0) {
                    listRef.current?.updateAndScrollToFocusedIndex(0);
                } else {
                    listRef.current?.updateAndScrollToFocusedIndex(-1);
                }

                const endTime = Date.now();
                Log.info('[CMD_K_DEBUG] Search query change completed', false, {
                    actionId,
                    duration: endTime - startTime,
                    finalInputLength: updatedUserQuery.length,
                    substitutionsUpdated: !deepEqual(autocompleteSubstitutions, updatedSubstitutionsMap),
                    timestamp: endTime,
                });
            } catch (error) {
                const endTime = Date.now();
                Log.alert('[CMD_K_FREEZE] Search query change failed', {
                    actionId,
                    error: String(error),
                    duration: endTime - startTime,
                    inputLength: userQuery.length,
                    timestamp: endTime,
                });
                throw error;
            }
        },
        [autocompleteSubstitutions, setTextInputValue, textInputValue],
    );

    const submitSearch = useCallback(
        (queryString: SearchQueryString) => {
            const queryWithSubstitutions = getQueryWithSubstitutions(queryString, autocompleteSubstitutions);
            const updatedQuery = getQueryWithUpdatedValues(queryWithSubstitutions);
            if (!updatedQuery) {
                return;
            }

            backHistory(() => {
                onRouterClose();
                Navigation.navigate(ROUTES.SEARCH_ROOT.getRoute({query: updatedQuery}));
            });

            setTextInputValue('');
            setAutocompleteQueryValue('');
        },
        [autocompleteSubstitutions, onRouterClose, setTextInputValue],
    );

    const setTextAndUpdateSelection = useCallback(
        (text: string) => {
            setTextInputValue(text);
            shouldScrollRef.current = true;
            setSelection({start: text.length, end: text.length});
        },
        [setSelection, setTextInputValue],
    );

    const onListItemPress = useCallback(
        (item: OptionData | SearchQueryItem) => {
            const actionId = `list_item_press_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const startTime = Date.now();

            Log.info('[CMD_K_DEBUG] List item press started', false, {
                actionId,
                itemType: isSearchQueryItem(item) ? 'SearchQueryItem' : 'OptionData',
                searchItemType: isSearchQueryItem(item) ? item.searchItemType : undefined,
                hasSearchQuery: isSearchQueryItem(item) ? !!item.searchQuery : undefined,
                hasReportID: 'reportID' in item ? !!item.reportID : undefined,
                hasLogin: 'login' in item ? !!item.login : undefined,
                timestamp: startTime,
            });

            const setFocusAndScrollToRight = () => {
                try {
                    InteractionManager.runAfterInteractions(() => {
                        if (!textInputRef.current) {
                            Log.info('[CMD_K_DEBUG] Focus skipped - no text input ref', false, {
                                actionId,
                                timestamp: Date.now(),
                            });
                            return;
                        }
                        textInputRef.current.focus();
                        scrollToRight(textInputRef.current);
                    });
                } catch (error) {
                    Log.alert('[CMD_K_FREEZE] Focus and scroll failed', {
                        actionId,
                        error: String(error),
                        timestamp: Date.now(),
                    });
                }
            };

            try {
                if (isSearchQueryItem(item)) {
                    if (!item.searchQuery) {
                        Log.info('[CMD_K_DEBUG] List item press skipped - no search query', false, {
                            actionId,
                            itemType: 'SearchQueryItem',
                            timestamp: Date.now(),
                        });
                        return;
                    }

                    if (item.searchItemType === CONST.SEARCH.SEARCH_ROUTER_ITEM_TYPE.CONTEXTUAL_SUGGESTION) {
                        const searchQuery = getContextualSearchQuery(item);
                        const newSearchQuery = `${searchQuery}\u00A0`;
                        onSearchQueryChange(newSearchQuery, true);
                        setSelection({start: newSearchQuery.length, end: newSearchQuery.length});

                        const autocompleteKey = getContextualSearchAutocompleteKey(item);
                        if (autocompleteKey && item.autocompleteID) {
                            const substitutions = {...autocompleteSubstitutions, [autocompleteKey]: item.autocompleteID};
                            setAutocompleteSubstitutions(substitutions);
                        }
                        setFocusAndScrollToRight();

                        const endTime = Date.now();
                        Log.info('[CMD_K_DEBUG] Contextual suggestion handled', false, {
                            actionId,
                            duration: endTime - startTime,
                            newQueryLength: newSearchQuery.length,
                            hasSubstitutions: !!(autocompleteKey && item.autocompleteID),
                            timestamp: endTime,
                        });
                    } else if (item.searchItemType === CONST.SEARCH.SEARCH_ROUTER_ITEM_TYPE.AUTOCOMPLETE_SUGGESTION && textInputValue) {
                        const trimmedUserSearchQuery = getQueryWithoutAutocompletedPart(textInputValue);
                        const newSearchQuery = `${trimmedUserSearchQuery}${sanitizeSearchValue(item.searchQuery)}\u00A0`;
                        onSearchQueryChange(newSearchQuery, true);
                        setSelection({start: newSearchQuery.length, end: newSearchQuery.length});

                        if (item.mapKey && item.autocompleteID) {
                            const substitutions = {...autocompleteSubstitutions, [item.mapKey]: item.autocompleteID};
                            setAutocompleteSubstitutions(substitutions);
                        }
                        setFocusAndScrollToRight();

                        const endTime = Date.now();
                        Log.info('[CMD_K_DEBUG] Autocomplete suggestion handled', false, {
                            actionId,
                            duration: endTime - startTime,
                            trimmedQueryLength: trimmedUserSearchQuery.length,
                            newQueryLength: newSearchQuery.length,
                            hasMapKey: !!(item.mapKey && item.autocompleteID),
                            timestamp: endTime,
                        });
                    } else {
                        submitSearch(item.searchQuery);

                        const endTime = Date.now();
                        Log.info('[CMD_K_DEBUG] Search submitted', false, {
                            actionId,
                            duration: endTime - startTime,
                            searchQuery: item.searchQuery,
                            timestamp: endTime,
                        });
                    }
                } else {
                    backHistory(() => {
                        if (item?.reportID) {
                            Navigation.navigate(ROUTES.REPORT_WITH_ID.getRoute(item.reportID));
                        } else if ('login' in item) {
                            navigateToAndOpenReport(item.login ? [item.login] : [], false);
                        }
                    });
                    onRouterClose();

                    const endTime = Date.now();
                    Log.info('[CMD_K_DEBUG] Navigation item handled', false, {
                        actionId,
                        duration: endTime - startTime,
                        reportID: item?.reportID,
                        hasLogin: 'login' in item ? !!item.login : false,
                        timestamp: endTime,
                    });
                }
            } catch (error) {
                const endTime = Date.now();
                Log.alert('[CMD_K_FREEZE] List item press failed', {
                    actionId,
                    error: String(error),
                    duration: endTime - startTime,
                    itemType: isSearchQueryItem(item) ? 'SearchQueryItem' : 'OptionData',
                    searchItemType: isSearchQueryItem(item) ? item.searchItemType : undefined,
                    timestamp: endTime,
                });
                throw error;
            }
        },
        [autocompleteSubstitutions, onRouterClose, onSearchQueryChange, submitSearch, textInputValue],
    );

    const updateAutocompleteSubstitutions = useCallback(
        (item: SearchQueryItem) => {
            if (!item.autocompleteID || !item.mapKey) {
                return;
            }

            const substitutions = {...autocompleteSubstitutions, [item.mapKey]: item.autocompleteID};
            setAutocompleteSubstitutions(substitutions);
        },
        [autocompleteSubstitutions],
    );

    useKeyboardShortcut(CONST.KEYBOARD_SHORTCUTS.ESCAPE, () => {
        onRouterClose();
    });

    const modalWidth = shouldUseNarrowLayout ? styles.w100 : {width: variables.searchRouterPopoverWidth};
    const isRecentSearchesDataLoaded = !isLoadingOnyxValue(recentSearchesMetadata);

    return (
        <View
            style={[styles.flex1, modalWidth, styles.h100, !shouldUseNarrowLayout && styles.mh85vh]}
            testID={SearchRouter.displayName}
            ref={ref}
            onStartShouldSetResponder={() => true}
            onResponderRelease={Keyboard.dismiss}
        >
            {shouldUseNarrowLayout && (
                <HeaderWithBackButton
                    title={translate('common.search')}
                    onBackButtonPress={() => onRouterClose()}
                    shouldDisplayHelpButton={false}
                />
            )}
            {isRecentSearchesDataLoaded && (
                <>
                    <SearchInputSelectionWrapper
                        value={textInputValue}
                        isFullWidth={shouldUseNarrowLayout}
                        onSearchQueryChange={onSearchQueryChange}
                        onSubmit={() => {
                            const focusedOption = listRef.current?.getFocusedOption();

                            if (!focusedOption) {
                                submitSearch(textInputValue);
                                return;
                            }

                            onListItemPress(focusedOption);
                        }}
                        caretHidden={shouldHideInputCaret}
                        autocompleteListRef={listRef}
                        shouldShowOfflineMessage
                        wrapperStyle={{...styles.border, ...styles.alignItemsCenter}}
                        outerWrapperStyle={[shouldUseNarrowLayout ? styles.mv3 : styles.mv2, shouldUseNarrowLayout ? styles.mh5 : styles.mh2]}
                        wrapperFocusedStyle={styles.borderColorFocus}
                        isSearchingForReports={isSearchingForReports}
                        selection={selection}
                        substitutionMap={autocompleteSubstitutions}
                        ref={textInputRef}
                    />
                    <SearchAutocompleteList
                        autocompleteQueryValue={autocompleteQueryValue || textInputValue}
                        handleSearch={searchInServer}
                        searchQueryItem={searchQueryItem}
                        getAdditionalSections={getAdditionalSections}
                        onListItemPress={onListItemPress}
                        setTextQuery={setTextAndUpdateSelection}
                        updateAutocompleteSubstitutions={updateAutocompleteSubstitutions}
                        onHighlightFirstItem={() => listRef.current?.updateAndScrollToFocusedIndex(1)}
                        ref={listRef}
                        textInputRef={textInputRef}
                    />
                </>
            )}
        </View>
    );
}

SearchRouter.displayName = 'SearchRouter';

export default forwardRef(SearchRouter);

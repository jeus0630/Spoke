import React, { Component, Suspense, lazy } from "react";
import { BrowserRouter as Router, Route, Switch } from "react-router-dom";
import PropTypes from "prop-types";

import GlobalStyle from "./GlobalStyle";

import Loading from "./Loading";

import { ApiContextProvider } from "./contexts/ApiContext";
import { AuthContextProvider } from "./contexts/AuthContext";

import { Telemetry } from "../telemetry";

import { ThemeProvider } from "styled-components";

import { Column } from "./layout/Flex";

import theme from "./theme";

const EditorContainer = lazy(() =>
  import(/* webpackChunkName: "project-page", webpackPrefetch: true */ "./EditorContainer")
);

export default class App extends Component {
  static propTypes = {
    api: PropTypes.object.isRequired
  };

  constructor(props) {
    super(props);

    this.state = {
      isAuthenticated: props.api.isAuthenticated()
    };
  }

  componentDidMount() {
    this.props.api.addListener("authentication-changed", this.onAuthenticationChanged);
  }

  onAuthenticationChanged = isAuthenticated => {
    this.setState({ isAuthenticated });
  };

  componentWillUnmount() {
    this.props.api.removeListener("authentication-changed", this.onAuthenticationChanged);
  }

  render() {
    const api = this.props.api;

    return (
      <ApiContextProvider value={api}>
        <AuthContextProvider value={this.state.isAuthenticated}>
          <ThemeProvider theme={theme}>
            <Router basename={process.env.ROUTER_BASE_PATH}>
              <GlobalStyle />
              <Column as={Suspense} fallback={<Loading message="Loading..." fullScreen />}>
                <Switch>
                  <Route path="*" component={EditorContainer} />
                </Switch>
              </Column>
              <Telemetry />
            </Router>
          </ThemeProvider>
        </AuthContextProvider>
      </ApiContextProvider>
    );
  }
}
